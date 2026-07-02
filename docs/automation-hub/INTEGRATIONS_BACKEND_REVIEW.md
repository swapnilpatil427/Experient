# Integrations Backend Review — Settings Page Readiness

**Author:** Nina Reeves (Platform Integration / Architectural Integrity)
**Status:** Final — design decisions below are implemented in this same change
**Cross-checked against:** `docs/automation-hub/INTEGRATIONS_CONNECTOR_SPEC.md` (David
Mensah, Integration Engineer). This doc supersedes David's spec only where noted
(§2, §3, §6); everywhere else his field/error-message tables are the ones the
frontend should build against verbatim.

**Mid-review addendum:** Rohan's parallel spec work surfaced a real bug in
`setCredentials` (full overwrite instead of merge — see new §0) and proposed a
different resolution for the Slack question in §2 (client-side merge of two
calls, to avoid coupling `workflow_connector_credentials` and
`notification_channels`). Both are addressed below: §0 is a straight bug fix
(no disagreement, just landed as part of this same pass since it's directly in
the path of the settings-page edit flow being built); §2 keeps my original
backend-unification recommendation, with the tradeoff against Rohan's
alternative made explicit.

---

## 0. Bug found: `setCredentials` overwrites instead of merges (fixed)

`setCredentials` (`backend/src/lib/workflowCredentials.ts`) encrypted and stored
`data` as the *entire* credential row, discarding whatever was previously saved.
Combined with `GET` never returning decrypted secrets (by design, so the settings
page can't prefill a form with real values), the natural edit-flow UI pattern is
"only send the field(s) the user actually changed" — e.g. rotating just
`apiToken` on an already-configured Jira connector that also has
`baseUrl`/`email`/`projectKey` saved. Under the old behavior, a `PUT
/api/workflow-credentials/jira` with `{ data: { apiToken: 'new' } }` would silently
null out the other three fields, degrading every workflow action relying on that
connector until an admin noticed and re-entered everything.

**Fixed:** `setCredentials` now decrypts the existing row (if one exists),
shallow-merges incoming `data` on top, then re-encrypts and stores the merged
result. Merge semantics: any key present in `data` overwrites; any key *absent*
from `data` is preserved from the existing row. (An explicit `null`/empty value
in `data` still clears that one field — merge only protects keys that aren't
mentioned at all.) Regression test:
`workflowCredentialsRoutes.test.js` → "merges a partial update onto existing
stored fields instead of replacing them" — asserts a `PUT` with only `apiToken`
against a connector that also has `baseUrl`/`email`/`projectKey` saved produces a
stored row with all four fields, not just the one sent.

This was a pre-existing bug, not introduced by the test-connection work — but it
belongs in this same pass since it is exactly the kind of interaction a
credentials-vault settings page brings from theoretical to guaranteed-to-happen.

---

## 1. Is `GET /api/workflow-credentials` settings-page-ready?

**No — as written today it under-reports.** Read the route
(`backend/src/routes/workflowCredentials.ts:23-30`) and its backing query
(`backend/src/lib/workflowCredentials.ts::listConfiguredConnectors`, lines 168-174):

```ts
router.get('/', ...);
const configured = await listConfiguredConnectors(req.orgId);
res.json({ connectors: configured });
```

`listConfiguredConnectors` does a single `SELECT ... FROM workflow_connector_credentials
WHERE org_id = $1` and returns only the rows that exist. Today's response shape is:

```json
{ "connectors": [ { "connector": "zendesk", "createdAt": "...", "updatedAt": "..." } ] }
```

This gives exactly **one bit of information per configured connector** ("this org has
a vault row") and **says nothing about connectors that are absent from the array**.
A settings page needs to render all `CONNECTORS` (minus `webhook`/`slack` special
cases — see §2 and §6) in one of three states:

1. **Connected (org)** — a vault row exists for this org.
2. **Using shared default** — no vault row, but the connector's `process.env.*`
   fallback vars are set on this deployment (so the connector is *functionally*
   configured, just not per-org).
3. **Not connected** — no vault row, no env fallback either; the connector is
   inert for this org until someone configures it.

Today's response can only express state 1 vs. "not in the array" — states 2 and 3
are indistinguishable from the current payload. A naive settings-page
implementation would render every non-listed connector identically ("Not
connected"), which is actively misleading for orgs still running on the pre-Wave-1
shared env vars (the default for every org that hasn't touched the new settings
page yet, per `connectors.ts`'s fallback chain and the TRACKER's Wave 1 design
note). Those orgs *are* wired up — Jira/Salesforce/ServiceNow/Zendesk actions will
actually fire — the settings page just can't say so today.

**Decision: extend `GET /api/workflow-credentials` to report all three states per
connector**, rather than just the raw vault-row list. New response shape (raw vault
list also kept for back-compat / non-UI callers — see exact shape in §6):

```json
{
  "connectors": [
    { "connector": "jira",        "status": "org",     "createdAt": "...", "updatedAt": "..." },
    { "connector": "salesforce",  "status": "shared" },
    { "connector": "servicenow",  "status": "none" },
    { "connector": "zendesk",     "status": "org", "createdAt": "...", "updatedAt": "..." },
    { "connector": "slack",       "status": "org" },
    { "connector": "webhook",     "status": "none" }
  ]
}
```

`status: 'shared'` is computed by checking whether the connector's required
`process.env.*` vars are all present (same fields David's spec marks "Required" per
connector) — **not** by making a live outbound call; this is a config-presence
check, cheap and synchronous, distinct from the Test Connection call in §3. This
required extracting each connector's env-var-fallback field list into a small
shared table (`CONNECTOR_ENV_FIELDS` in `workflowCredentials.ts`) so
`listConfiguredConnectors` doesn't duplicate `connectors.ts`'s per-connector field
names — see §6 for the exact implementation.

---

## 2. Does the response need to include Slack?

**Yes — unify into one response.** Reasoning:

- Rohan's UX intent (per the task brief, and consistent with David's spec §5) is
  for Slack to look identical to the other 4 connectors from the user's
  perspective — one card in a grid of 5, same "Connected / Not connected" visual
  language. If the frontend has to call `/api/workflow-credentials` for 4
  connectors and `/api/notification-channels` for the 5th, then client-side-merge
  two differently-shaped responses (`{connector, status}` vs.
  `{id, channelType, channelName, configPreview, isActive, createdAt}`) into one
  uniform list, that merge logic has to be reimplemented (and kept in sync)
  wherever the settings page or any other consumer needs "all 5 connector
  statuses." That's exactly the kind of special-casing the unified-backend
  approach avoids.
- The backend already knows how to query `notification_channels` (channels.ts's
  `sendSlack` does it today). Having `workflowCredentials.ts` query it too is a
  small, contained addition — one extra `SELECT` — not a new dependency.
- It does **not** mean Slack's credentials move into the
  `workflow_connector_credentials` vault, and it does **not** change where Slack's
  `PUT`/`DELETE` happen. David's spec is correct that Slack write operations stay
  on `/api/notification-channels` (`routes/notificationChannels.ts`), since that
  table's row shape (`channel_type`, `is_active`, soft-delete via `deleted_at`)
  is meaningfully different from the vault's (encrypted blob, hard-delete,
  one-row-per-org-per-connector). Only the **read** path is unified.

**Decision: `GET /api/workflow-credentials` internally queries both
`workflow_connector_credentials` and `notification_channels` (`channel_type =
'slack'`), and returns Slack as a normal entry in the same `connectors` array**
(`status: 'org'` if an active, non-deleted Slack channel row exists, else `'none'`
— Slack has no "shared env var" fallback concept, so it only ever has `org`/`none`,
never `shared`). This keeps the frontend to one call and one response shape for
all 5 connectors. Slack's row includes `createdAt`/`updatedAt` (sourced from
`notification_channels.created_at`/`updated_at`) so the UI gets "connected since"
copy uniformly across all 5, not just 4.

**Addressing Rohan's counter-proposal (client-side merge of two calls, to avoid
coupling the two tables):** I considered this and am keeping the backend
unification. Reasoning for the tradeoff:

- The "coupling" this introduces is a single read-only, unindexed-nothing-special
  `SELECT ... FROM notification_channels WHERE org_id = $1 AND channel_type =
  'slack' ...` — the *exact same query shape* `channels.ts::sendSlack` already
  runs on every notification dispatch in production today. `workflowCredentials.ts`
  reading it too doesn't create a new dependency between subsystems that weren't
  already both part of "workflow automation notifications"; it's a query-level
  read, not a schema/write coupling. There's no migration, no FK, no shared
  transaction — genuinely low-risk coupling.
- The alternative (client-side merge) pushes real logic — "here are two arrays
  with different shapes, some fields have different names
  (`channelType`/`connector`, `isActive`/`status`), merge them into one uniform
  list, keep them in sync if either shape changes" — into the frontend, and
  duplicates that merge logic in every place that needs "all 5 connectors'
  status" (today: one settings page; foreseeably: a workflow-builder action-step
  picker that wants to gray out unconfigured connectors, or a dashboard widget).
  Each consumer either re-implements the merge or imports a shared frontend
  utility that has to track two backend response shapes forever. A backend
  change is cheaper to keep correct over time than N frontend call sites doing
  the same merge.
- Rohan's UX goal (Slack indistinguishable from the other 4 to the *user*)
  is best served by making it indistinguishable to the *frontend code* too —
  otherwise there's a permanent asymmetry (4 connectors from one call, 1 from
  another) that every future feature touching "connector status" has to
  remember and handle.
- If `notification_channels` ever needs to change independent of
  `workflow_connector_credentials` (e.g. multi-channel-per-org, per-Rohan's own
  spec flagging that as a possible future need), this read stays a simple
  `SELECT` either way — unification doesn't lock in Slack's schema, it only
  reads whatever that table currently exposes.

If a future concern makes this coupling genuinely costly (e.g. `notification_channels`
moves to a different service/datastore entirely), splitting the read back out is a
contained change — it only touches `getConnectorStatuses()`, not every consumer,
which is the whole point of centralizing the merge on the backend now.

---

## 3. `POST /api/workflow-credentials/:connector/test`

Cross-checked against David's connector-by-connector calls (§3 below matches his
doc's `myself`/`describe`/`sys_user`/`users/me.json` choices exactly — no
conflict). Route/shape decisions that are mine to make (backend routing, response
envelope, Slack handling) are below; per-connector API calls and error-message
copy are David's and are not restated in full here (see
`INTEGRATIONS_CONNECTOR_SPEC.md` §1-5 for the authoritative field/message tables).

### Verb and path
`POST /api/workflow-credentials/:connector/test` for jira/salesforce/servicenow/zendesk.
POST (not PUT) because this is an action/verb ("run a test"), not an idempotent
resource replacement — matches the existing `PUT` (replace credentials) vs. the new
"do a thing" semantics.

### Request body
Same envelope as `PUT`: `{ data: { ...candidateFields } }`. When `data` is present,
test **those exact values** — never touch the vault. When `data` is omitted, fall
back to the org's saved credentials (vault row via `getCredentials`), and if no
vault row exists, fall back further to the deployment's shared env vars (the same
three-tier resolution `connectors.ts` already does for real actions) — so a
previously-configured-but-unverified connector, or an env-var-only org, can still
click "Test Connection" without re-entering secrets. This required extracting each
connector's `org?.field || process.env.FIELD` resolution into a shared, exported
helper (see §6) so the test endpoint and `connectors.ts`'s real actions share one
implementation instead of two copies that could drift.

### Response shape
```
{ success: true, message?: string, checks?: Record<string, "ok"> }
{ success: false, message: string, failedCheck?: string }
```
`message` is always present on failure, optional on success (Jira/ServiceNow's
multi-check flows get a `checks` object for transparency; single-call connectors
just get `success: true`). This matches David's per-connector envelopes without
forcing every connector into his 2-call Jira shape.

### Status-code → message mapping
Implemented centrally in a `mapConnectorTestError(status, connector)` helper
(`backend/src/lib/connectorTest.ts`) so 401/403/404/timeout/network-refused/429
map consistently, then each connector supplies only its specific wording deltas
(e.g. Jira's "check id.atlassian.com" vs. Zendesk's "check Admin Center") per
David's tables. Generic fallback for any status not explicitly covered: `"{Connector}
returned an unexpected error (HTTP {status})."`

### Permission gate
`requireAuth` + `requirePermission('workflows:manage')` — identical to `PUT`/`DELETE`
on this router. No new permission scope introduced.

### Slack — decision
**David's Option A (send a real, visible test message), same recommendation
independently reached.** Slack incoming webhooks genuinely have no side-effect-free
auth-check verb — this is a hard product constraint, not a research gap. Given
that, and per §2's unification decision, Slack's test-connection lives on the
**same unified surface** as the other 4 rather than splitting under
`/api/notification-channels/slack/test` as David's open question suggested:

**`POST /api/workflow-credentials/slack/test`** — even though Slack's underlying
config table differs, the *test* action is read-only-ish (well, write-a-message-ish)
and stateless either way, so there's no ownership reason it must live under
`notificationChannels.ts`. Centralizing all 5 connectors' test endpoints under one
router matches §2's "one surface for the settings page" reasoning and avoids the
frontend needing a special-cased URL for exactly one of five buttons. Internally,
the handler for `connector === 'slack'` reads/accepts a `webhook_url` from `data`
(or falls back to the org's saved `notification_channels` row) and POSTs the test
message directly — it does not proxy through `notificationChannels.ts` code, it
calls the same minimal logic `sendSlack` uses, inlined, since sending a fixed test
string is simpler than reusing the full `DispatchableNotification` dispatch path.

Response: `{ success: true, message: "Test message sent — check your Slack channel." }`
or `{ success: false, message: "<reason>" }` (no `checks`/`failedCheck` — a single
call, single outcome). UI copy is Rohan's call, but the endpoint's `message` text
softly signals the side effect per David's suggested framing.

### Webhook connector — not exposed for testing
`workflow_connector_credentials`'s `webhook` entry stores only `{ secret }` — an
HMAC-signing secret for the org's *own outbound* webhook calls
(`workflowEngine.ts:253-268`, `case 'notify.webhook'`). There is no fixed target
URL in the vault to test against (the URL is per-workflow-action `config.url`, set
in the builder, not here) — "testing" a signing secret means nothing without a
receiving endpoint to sign a payload for. **`POST
/api/workflow-credentials/webhook/test` returns 400** (`"webhook credentials have
no test — there is no fixed endpoint to validate; the signing secret is exercised
when a workflow's notify.webhook action actually runs"`) rather than silently
doing nothing or faking a success. This is intentionally different from David's
scope note (he flagged `webhook` as possibly-dead based on only reading
`connectors.ts`) — it's very much alive (`workflowEngine.ts` reads it), it's just
not test-able the way the other 4 are, for a structural reason (no stored URL),
not a validation gap.

---

## 4. Security review of the test endpoint

Reviewed how existing connector code logs failures
(`connectors.ts` lines 91, 95, 120, 124, 155, 159, 197, 201 — every `log('warn', ...)`
call passes only `{ event, status }` or `{ event, err: msg }` where `msg` is
`Error.message`, e.g. `"fetch failed"` or an HTTP-layer message — never headers,
never the request body, never the credential values). The new test endpoint
follows the identical discipline:

- The route handler never logs `req.body` / `data` as a whole object.
- `mapConnectorTestError` and the per-connector test functions only ever log
  `{ event: 'connector_test_failed', connector, status }` — same shape as the
  existing real-action failure logs, deliberately reusing the pattern rather than
  inventing a new one.
- Verified no error path lets a raw fetch error object (which can embed request
  headers in some Node fetch implementations) get passed to `log()` directly —
  always through `err instanceof Error ? err.message : String(err)` first, exactly
  like the existing connectors.
- Response bodies sent back to the client also never echo the tested credentials —
  `success`/`message`/`checks`/`failedCheck` only. Confirmed by a test asserting
  `JSON.stringify(body)` doesn't contain the test token (mirrors the existing
  `GET /api/workflow-credentials` test's same assertion style).
- Because `data` bypasses the vault entirely (by design — testing pre-save
  values), it's not persisted anywhere, so there's no at-rest exposure to review;
  the only exposure surface is in-memory for the duration of the request and
  whatever Express/Pino might auto-log at the HTTP-access-log layer. Checked
  `middleware/httpLogger.ts` — confirmed it logs method/path/status/duration only,
  never `req.body`, so no change needed there.

No findings requiring a fix beyond following the existing logging discipline,
which the implementation below does.

---

## 5. Rate limiting

`/api/workflow-credentials` is mounted with only the general `apiLimiter` (500
req/org/15min, `index.ts:209`) — appropriate for `GET`/`PUT`/`DELETE`, which are
local DB operations with no external cost. **The test endpoint is different: every
call makes a real outbound HTTP request to a third party** (Jira/Salesforce/
ServiceNow/Zendesk/Slack). At 500/15min an org could still hammer a third party
several hundred times in a burst — fine for us, not necessarily fine for Zendesk's
or Slack's own rate limits, and it's the kind of endpoint a buggy frontend retry
loop or an impatient user mashing "Test Connection" could abuse.

**Decision: add a dedicated, tighter limiter for the `/test` sub-route only**,
following the exact pattern `aiLimiter` uses for `/api/ai` (a second, stricter
limiter layered on top of `apiLimiter`, keyed by org):

```ts
export const connectorTestLimiter = makeRateLimiter({
  max: 10,
  keyFn: (req) => `connector-test:${req.orgId || req.ip}`,
});
```

10 requests per org per 15 minutes. Reasoning for the number: a real settings-page
session testing all 5 connectors while iterating on a typo is maybe 2-3 attempts
per connector — 10 total covers a legitimate debugging session with room to spare,
while still bounding worst-case outbound call volume to a third party from a single
misbehaving client. Mounted only on the `POST .../test` route (not the whole
router), so `GET`/`PUT`/`DELETE` keep their existing 500/15min ceiling unaffected.
`DEV_MODE` bypass mirrors `apiLimiter`/`aiLimiter`'s existing skip-in-dev behavior
(same `_skipRateLimit` flag), so local dev isn't throttled either.

---

## Summary of decisions for the frontend engineer

| # | Decision |
|---|---|
| 0 | **Bug fix:** `setCredentials` now merges partial updates onto the existing stored row instead of overwriting it wholesale — a `PUT` with only `{ apiToken }` no longer wipes `baseUrl`/`email`/`projectKey`. See §0. |
| 1 | `GET /api/workflow-credentials` now returns `status: 'org'\|'shared'\|'none'` per connector, for all 6 `CONNECTORS` entries, not just configured ones. |
| 2 | Slack is included in the same response (queries `notification_channels` internally) — one call for all 5 user-facing connectors. Slack's write path (`PUT`/`DELETE`) stays on `/api/notification-channels`, unchanged. Considered and rejected Rohan's client-side-merge alternative — see §2 tradeoff. |
| 3 | New `POST /api/workflow-credentials/:connector/test` for jira/salesforce/servicenow/zendesk/slack. Accepts `{ data: {...} }` to test unsaved values; omitted `data` tests saved vault → env-var fallback, in that order. `webhook` returns 400 (not testable — no stored URL). Response: `{ success, message?, checks?, failedCheck? }`. |
| 4 | No logging of raw credential values anywhere in the new code path — verified against existing `connectors.ts` discipline and covered by a test. |
| 5 | New `connectorTestLimiter` (10 req/org/15min) layered on the `/test` route only, same pattern as `aiLimiter`. |

**Exact final API shapes:**

```
GET /api/workflow-credentials
→ 200 { connectors: [
    { connector: 'jira'|'salesforce'|'servicenow'|'zendesk'|'slack'|'webhook',
      status: 'org'|'shared'|'none',
      createdAt?: string, updatedAt?: string } , ...
  ] }

PUT /api/workflow-credentials/:connector
  body: { data: Record<string, unknown> }   // MERGES onto any existing saved row
→ 200 { connector, configured: true }
→ 400 { error: 'Unknown connector...' }
→ 503 { error: 'Credentials vault is not configured on this deployment' }  (WORKFLOW_CREDENTIALS_KEY unset)

POST /api/workflow-credentials/:connector/test
  body (optional): { data: Record<string, unknown> }
→ 200 { success: true, message?: string, checks?: Record<string,string> }
→ 200 { success: false, message: string, failedCheck?: string }   (includes "not configured" when no data/vault/env resolves — this is a 200 envelope, not a 503, since the endpoint's job is to report test outcomes, not vault availability)
→ 400 { error: 'Unknown connector...' }               (bad :connector)
→ 400 { error: 'webhook credentials have no test...' } (:connector === 'webhook')
→ 403 { error: 'Insufficient permissions', ... }       (requirePermission failure)
→ 429 { error: 'rate_limited', ... }                   (connectorTestLimiter)
```
