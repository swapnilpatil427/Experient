# Integrations Connector Spec — Settings Page

**Author:** David Mensah (Integration Engineer)
**Status:** Draft for Rohan (UX) and Nina (backend) — Wave 2, Automation Hub
**Scope:** Org-level connection credentials ONLY (the vault). Per-workflow-action
config (e.g. `config.projectKey` override, `config.priority`, `config.tags`) is set
inside the workflow builder's action step, not here — do not add those fields to
this settings page.

## Source of truth

Every field below is read directly from `backend/src/lib/connectors.ts` (what the
connector actually calls `getCredentials(orgId, connector)` for, with its
`process.env.*` fallback) and `backend/src/lib/channels.ts::sendSlack` (the
separate `notification_channels` table, not the vault). Field names in the "Vault
key" column are exactly what a settings-page `PUT /api/workflow-credentials/:connector`
call must send in `data` — do not rename them; connectors.ts destructures these
exact keys with no aliasing.

Confirmed vault shape per connector (from the `Partial<{...}>` type hints
connectors.ts casts `getCredentials()`'s return to):
- `jira`: `{ baseUrl, email, apiToken, projectKey }`
- `salesforce`: `{ instanceUrl, accessToken }`
- `servicenow`: `{ instanceUrl, user, password }`
- `zendesk`: `{ subdomain, email, apiToken }`
- `slack`: not part of this vault at all — see §5.

Note: `workflowCredentials.ts`'s `CONNECTORS` list also includes `slack` and
`webhook` as valid vault connector names (so `PUT /api/workflow-credentials/slack`
and `/webhook` would technically succeed today), but **no connector code in
`connectors.ts` or `channels.ts` ever reads `getCredentials(orgId, 'slack')`** —
Slack is wired exclusively through `notification_channels`. This settings page
should route Slack's field to the `notification_channels` API
(`PUT /api/notification-channels`), not to `/api/workflow-credentials/slack`, or
the org will fill in a form field that is silently never read. Flagging this as a
discrepancy Nina should confirm/fix (either remove `slack`/`webhook` from the
vault's `CONNECTORS` enum, or wire them up) — see §7.

---

## 1. Jira

Read from `jiraCreateIssue` (`connectors.ts:56-98`).

### Fields

| Field (vault key) | Label | Type | Required | Placeholder / help |
|---|---|---|---|---|
| `baseUrl` | Jira base URL | url | Yes | `https://yourorg.atlassian.net` |
| `email` | Jira account email | text (email) | Yes | `integrations@yourorg.com` — the email of the account that owns the API token |
| `apiToken` | API token | password | Yes | Generate at id.atlassian.com → Security → API tokens |
| `projectKey` | Default project key | text | Yes | `SUP` — the Jira project new issues are created in by default (a workflow action can override this per-action, but a default is required so the connector isn't `not_configured` when an action omits it) |

All four are required — `jiraCreateIssue` treats the connector as unconfigured
(`status: 'skipped'`) if any one of `baseUrl`/`email`/`token`/`projectKey` is
missing (note: `projectKey` falls back through `config.projectKey` →
`org.projectKey` → `env.JIRA_PROJECT_KEY`, in that order — but for the *settings
page* we should still require it, since a vault entry with 3 of 4 fields silently
degrades every workflow action that doesn't set its own `config.projectKey`).

### Validation (client-side, pre-save)

- `baseUrl`: must be a valid URL, `https://` scheme required, no trailing path
  (strip trailing `/` or warn). Reject bare domains without scheme.
- `email`: must match a standard email pattern (`x@y.z`).
- `apiToken`: non-empty, no format constraint (Atlassian tokens have no fixed
  public format/length to validate against) — just required + trim whitespace.
- `projectKey`: uppercase alphanumeric, 2–10 chars, matching Jira's own project
  key convention (`^[A-Z][A-Z0-9]{1,9}$`). Reject lowercase (Jira normalizes but
  we should catch typos before save).

### Test Connection

**Endpoint:** `POST /api/workflow-credentials/jira/test`
**Call:** `GET {baseUrl}/rest/api/3/myself` with the same Basic auth
(`base64(email:apiToken)`) `jiraCreateIssue` builds. This is the cheapest
authenticated, read-only Jira endpoint — it returns the authenticated user's
profile with zero side effects and validates `baseUrl`+`email`+`apiToken` together
in one call.

Then, since `projectKey` is not validated by `/myself`, chain a second call:
`GET {baseUrl}/rest/api/3/project/{projectKey}` — read-only, validates the project
key exists and the authenticated account can see it. Two calls, both safe, both
necessary to validate all 4 fields (mirrors the "pick the one that validates the
most fields" guidance, but here it takes two: no single Jira endpoint validates
both identity and project existence together).

**Response shape:**
```
{ success: true, checks: { auth: "ok", project: "ok" } }
```
or
```
{ success: false, failedCheck: "auth" | "project" | "network", message: "<human message>" }
```

**Does not persist anything** — decrypts the vault row (or uses the in-flight
unsaved form values passed in the test request body, see §6) and discards after
the call.

### Error messages

| Failure | Message |
|---|---|
| 401 from `/myself` | "Invalid email or API token — check that the token hasn't expired in your Atlassian account settings (id.atlassian.com → Security → API tokens)." |
| 403 from `/myself` | "This Jira account doesn't have permission to access the API. Check the account's site permissions." |
| 404 from `/myself` (bad base URL) | "Couldn't reach a Jira site at that URL — check the base URL (should look like `https://yourorg.atlassian.net`)." |
| 404 from `/project/{key}` | "Project key \"{projectKey}\" doesn't exist or isn't visible to this account." |
| Network timeout | "Connection to Jira timed out after 10 seconds — check the base URL is correct and reachable." |
| DNS/connection refused | "Couldn't connect to that Jira URL at all — double check the domain." |
| 429 | "Jira rate-limited this request — wait a minute and try again." |

---

## 2. Salesforce

Read from `salesforceUpdateContact` (`connectors.ts:101-127`).

### Fields

| Field (vault key) | Label | Type | Required | Placeholder / help |
|---|---|---|---|---|
| `instanceUrl` | Salesforce instance URL | url | Yes | `https://yourorg.my.salesforce.com` |
| `accessToken` | Access token | password | Yes | OAuth access token for a connected app / integration user (Xperiq does not manage the OAuth flow today — org pastes a long-lived token they generate themselves) |

Only these two fields are read from the vault. `contactId` and `fields` are
per-action config (`config.contactId`, `config.fields`), not org credentials —
excluded from this page per scope.

### Validation

- `instanceUrl`: valid URL, `https://` scheme required. No stricter domain check
  (Salesforce sandboxes/custom domains vary — `*.my.salesforce.com`,
  `*.salesforce.com`, or a fully custom "My Domain"). Don't over-constrain.
- `accessToken`: non-empty, trim whitespace. No public format to validate.

**Known limitation, flag to Nina/product, not solved by this form:** Salesforce
access tokens expire (typically 2 hrs–a few days depending on the connected app's
policy) and there's no refresh-token flow wired up anywhere in this codebase
(`salesforceUpdateContact` reads a static `accessToken`, no OAuth refresh). This
settings page will let an org paste a token that goes stale silently — the
existing behavior (env-var fallback) has the same problem today, so this is not a
regression, but it means "Test Connection passed" only proves the token works
*right now*, not that it will work next week. Worth a banner: "Access tokens
expire — you may need to re-enter this periodically until OAuth support is
added." Recommend a backlog item for a proper OAuth connected-app flow rather than
solving it in this pass.

### Test Connection

**Endpoint:** `POST /api/workflow-credentials/salesforce/test`
**Call:** `GET {instanceUrl}/services/data/v59.0/sobjects/Contact/describe` with
`Authorization: Bearer {accessToken}`. This is the safe read-only equivalent to
the real connector's PATCH — it describes the Contact object's schema, requires
valid auth, costs nothing, and creates/modifies nothing. It validates both fields
at once (a bad `instanceUrl` fails to resolve/gets a non-JSON response; a bad
token gets 401).

**Response shape:** same pattern as Jira — `{ success, message }` or
`{ success: false, failedCheck, message }`.

### Error messages

| Failure | Message |
|---|---|
| 401 | "Invalid or expired access token — Salesforce access tokens are short-lived; generate a new one from your connected app." |
| 404 / instance not found | "Couldn't reach a Salesforce org at that instance URL — check it matches exactly what's in your Salesforce org's My Domain settings." |
| 403 (INSUFFICIENT_ACCESS) | "This token doesn't have permission to read the Contact object — check the connected app's OAuth scopes." |
| Network timeout | "Connection to Salesforce timed out after 10 seconds." |
| Malformed instanceUrl (fetch throws before response) | "That doesn't look like a reachable URL — check for typos." |

---

## 3. ServiceNow

Read from `servicenowCreateIncident` (`connectors.ts:130-162`).

### Fields

| Field (vault key) | Label | Type | Required | Placeholder / help |
|---|---|---|---|---|
| `instanceUrl` | ServiceNow instance URL | url | Yes | `https://yourorg.service-now.com` |
| `user` | Username | text | Yes | Username of a ServiceNow account with `incident` table write access |
| `password` | Password | password | Yes | Password for that account (Basic auth — ServiceNow also supports OAuth, not used by this connector today) |

### Validation

- `instanceUrl`: valid URL, `https://` scheme. Soft-suggest (not hard-reject,
  ServiceNow allows custom domains) that it usually ends in `.service-now.com`.
- `user`: non-empty, trim whitespace.
- `password`: non-empty. No format constraint — don't leak ServiceNow's real
  password policy into client validation, that's their auth server's job.

### Test Connection

**Endpoint:** `POST /api/workflow-credentials/servicenow/test`
**Call:** `GET {instanceUrl}/api/now/table/sys_user?sysparm_limit=1` with Basic
auth (`base64(user:password)`) — matches the spec's suggested minimal read. Table
API GET with `sysparm_limit=1` is the cheapest real read: single-row result,
validates auth, validates the instance URL resolves to a real ServiceNow instance
(the Table API 404s cleanly on a non-ServiceNow host), and doesn't touch the
`incident` table at all so there's zero chance of it being confused with a real
create even under a race.

**Response shape:** same `{ success, message }` pattern.

### Error messages

| Failure | Message |
|---|---|
| 401 | "Invalid username or password for this ServiceNow instance." |
| 403 | "This account doesn't have permission to read the sys_user table — check its roles (needs at least `itil` or equivalent read access)." |
| 404 / non-ServiceNow host | "Couldn't find a ServiceNow instance at that URL — check the instance URL." |
| Network timeout | "Connection to ServiceNow timed out after 10 seconds." |
| 429 | "ServiceNow rate-limited this request — wait and try again." |

---

## 4. Zendesk

Read from `zendeskCreateTicket` (`connectors.ts:167-204`).

### Fields

| Field (vault key) | Label | Type | Required | Placeholder / help |
|---|---|---|---|---|
| `subdomain` | Zendesk subdomain | text | Yes | `yourorg` — from `yourorg.zendesk.com` (enter just the subdomain, not the full URL) |
| `email` | Agent email | text (email) | Yes | Email of the Zendesk agent account that owns the API token |
| `apiToken` | API token | password | Yes | Generate at Zendesk Admin Center → Apps and integrations → APIs → Zendesk API |

### Validation

- `subdomain`: required, alphanumeric + hyphens only, no dots/slashes/protocol
  (reject if the user pastes a full URL like `https://yourorg.zendesk.com` —
  either auto-strip it client-side or reject with a clear message; auto-strip is
  friendlier). Pattern: `^[a-z0-9][a-z0-9-]*$`.
- `email`: standard email format.
- `apiToken`: non-empty, trim whitespace.

### Test Connection

**Endpoint:** `POST /api/workflow-credentials/zendesk/test`
**Call:** `GET https://{subdomain}.zendesk.com/api/v2/users/me.json` with Basic
auth in Zendesk's token format (`base64(email/token:apiToken)`, matching exactly
what `zendeskCreateTicket` builds at line 178). This is the endpoint the task spec
recommends and it's correct: it validates all three fields in one shot
(subdomain resolves, email is a real agent, token is valid) with zero side
effects.

**Response shape:** same `{ success, message }` pattern.

### Error messages

| Failure | Message |
|---|---|
| 401 | "Invalid email or API token — check the token hasn't been revoked in Zendesk Admin Center." |
| 404 / subdomain not found (Zendesk returns a non-JSON error page or DNS fails) | "No Zendesk account found at that subdomain — check for typos (just the subdomain, e.g. \"yourorg\", not the full URL)." |
| 403 | "This Zendesk account doesn't have API access enabled — check Admin Center → Apps and integrations → APIs." |
| Network timeout | "Connection to Zendesk timed out after 10 seconds." |
| 429 | "Zendesk rate-limited this request — wait a minute and try again." |

---

## 5. Slack

Read from `sendSlack` (`channels.ts:80-110`) — **this is NOT the same vault as
the other four connectors.** Slack config lives in the `notification_channels`
table (`channel_type = 'slack'`, `config` JSONB column), managed via
`PUT /api/notification-channels` (`routes/notificationChannels.ts`), not
`/api/workflow-credentials/slack`.

### Field

| Field (config key) | Label | Type | Required | Placeholder / help |
|---|---|---|---|---|
| `webhook_url` | Slack webhook URL | url | Yes | `https://hooks.slack.com/services/T000/B000/XXXX` — from Slack's "Incoming Webhooks" app config; the target channel is chosen when you create the webhook in Slack, not here |

That's the only field `sendSlack` reads (`config?.webhook_url`). I confirmed no
code path reads a `channel` field anywhere — Slack incoming webhooks are bound to
one fixed channel at creation time on Slack's side, and this codebase has no
mechanism to override the channel per-request (no `channel:` key sent in the
Slack payload at `channels.ts:96-102`). **Do not add a "channel" field to this
form** — it would imply a capability that doesn't exist and silently be ignored.
If per-channel routing becomes a requirement later, it needs either Slack's
richer Bot Token API (`chat.postMessage` with a `channel` param) or multiple
webhook rows per org — both are backend changes, not form additions.

### Validation

- `webhook_url`: valid URL, must start with `https://hooks.slack.com/services/`
  (reject anything else outright — a webhook URL in any other shape is
  definitely wrong and this is a safe, specific client-side check unlike the
  other connectors' generic URL validation).

### Test Connection — honest tradeoff, no clean answer

Slack incoming webhooks have **no authentication-check endpoint**. The only verb
they support is POST-a-message. There is no `GET`/`HEAD`/dry-run request that
validates a webhook URL without it doing the one thing it does (post to the
channel). This is a real, permanent limitation of Slack's incoming-webhook
product (as opposed to a bot-token integration, which does have `auth.test`) —
not something we're missing due to under-research.

Two real options:

**Option A — Send a real, visible test message.** `POST {webhook_url}` with a
body like `{ text: "✅ Test message from Xperiq — your Slack integration is working." }`.
Pro: it's a true end-to-end test — if it succeeds, the org's Slack channel really
will receive real alerts. Con: it's not side-effect-free; a message appears in
the org's channel, visible to everyone in it, every time someone clicks "Test
Connection" (including repeated clicks while debugging).

**Option B — Don't offer a test-connection button for Slack at all**; just
validate the URL format client-side and tell the org "Save, then trigger a real
workflow (or use each template's built-in test-run) to confirm delivery."

**Recommendation: Option A**, with UI framing that sets expectations honestly —
button label "Send test message" (not "Test Connection", to avoid implying a
side-effect-free check like the other four connectors get), and copy under the
button: "This will post a real message to your configured Slack channel." This
matches how Slack's own app-directory integrations and most SaaS products (e.g.
PagerDuty, Datadog) handle incoming-webhook verification — sending a real test
message is the industry-standard pattern precisely because Slack gives no
alternative. Being upfront in the button copy avoids the surprise; silently
skipping verification (Option B) leaves orgs unable to confirm their webhook
before relying on it in production alerts, which is worse.

**Endpoint:** `POST /api/notification-channels/slack/test` (note: different
route prefix than the other four, since Slack lives under
`/api/notification-channels`, not `/api/workflow-credentials`) — Nina should
confirm whether to add this under `notificationChannels.ts` or centralize
test-connection routing; flagging as an open question rather than deciding
unilaterally since it touches her route ownership.

**Response:** `{ success: true, message: "Test message sent — check your Slack channel." }`
or `{ success: false, message: "<reason>" }`.

### Error messages

| Failure | Message |
|---|---|
| 404 (webhook revoked/deleted in Slack) | "This webhook URL is no longer valid — it may have been deleted or revoked in Slack. Generate a new one from Slack's Incoming Webhooks app config." |
| 400 (malformed payload — shouldn't happen with our fixed body, but Slack also 400s on invalid URLs) | "Slack rejected the request — double-check the webhook URL was copied correctly." |
| Network timeout | "Connection to Slack timed out after 10 seconds." |
| Non-2xx, no specific code | "Couldn't deliver a test message to Slack — check the webhook URL is correct and hasn't expired." |

---

## 6. Test Connection — shared design notes (applies to all 5)

- **New endpoint per connector**, e.g. `POST /api/workflow-credentials/:connector/test`
  (Slack under `/api/notification-channels/slack/test`, per §5). Auth/permission
  gate identical to the existing `PUT`: `requireAuth` + `requirePermission('workflows:manage')`
  (`users:manage` for the Slack/notification-channels route, matching that
  router's existing gate).
- **Request body:** accept the *candidate* credentials in the request body
  (`{ data: {...} }`, same shape as the `PUT` schema) rather than only testing
  what's already saved. This lets a user test-before-save — critical UX, since
  the whole point is catching a typo before committing it to the vault. If the
  body is omitted, fall back to testing the currently-saved vault row (or the
  env-var fallback — see §7's recommendation) so a saved-but-unverified
  connector can still be re-tested later without re-entering secrets.
- **Must never persist.** The test call decrypts/uses credentials only in
  memory for the duration of the outbound HTTP call, then discards. It must not
  write to `workflow_connector_credentials` or any other table, and must not be
  logged with the raw secret (mirror `connectors.ts`'s existing `log('warn', ...)`
  calls, which only ever log `status`/`reason`, never headers or tokens).
- **Timeout:** reuse `CONNECTOR_FETCH_TIMEOUT_MS` (10s, `connectors.ts:20`) for
  consistency — same "connection timed out after 10 seconds" ceiling and message
  across every connector's test call and its real action call.
- **Response contract (uniform across connectors):**
  ```
  { success: boolean, message: string, failedCheck?: string }
  ```
  `message` is always the human-readable string from the per-connector tables
  above — never a bare "Connection failed" or raw HTTP status with no
  explanation. `failedCheck` is optional structured metadata (e.g. `"auth"`,
  `"project"`, `"network"`) for telemetry/analytics, not required for the UI to
  render the message.

## 7. Migration / backward-compat

**No new persisted data required.** Test-connection is a stateless proxy call —
it needs no new table, no new column on `workflow_connector_credentials`, and no
schema migration. It's pure request/response, same durability profile as the
existing connectors' real action calls (nothing is logged beyond
status/reason, per existing pattern).

**Should env-var-fallback-configured orgs be able to test?** Recommend **yes,
but only after Nina resolves one prerequisite**: today, `getCredentials()`
returns `null` for any org with no vault row (`workflowCredentials.ts:118-142`),
and connectors then fall back to `process.env.*` directly inside
`connectors.ts` — the *env var fallback is invisible to any API caller other than
the connector functions themselves*. There is no existing endpoint that returns
"what would this connector's effective credentials be right now" for an org with
no vault row. To let such an org click "Test Connection" and validate their
env-var-based setup, the test endpoint must replicate connectors.ts's exact
fallback order (`org?.field || process.env.FIELD`) rather than only reading the
vault — which means it duplicates (or better, imports and reuses) the same
resolution logic connectors.ts already has, rather than a fresh vault-only read.

**Recommendation:** build it — reuse the fallback, don't gate testing to
vault-configured orgs only. Reasoning:
1. It's the *same* underlying HTTP call regardless of credential source; the
   only difference is which values populate `baseUrl`/`email`/`apiToken`/etc.
   Restricting the feature to vault-only orgs for no technical reason would just
   be a confusing product gap — an org on env-var fallback today (the pre-Wave-1
   default, still true for any org that hasn't visited the new settings page
   yet) is exactly the org most likely to be unsure whether their (deployment-
   shared) credentials still work, and today has zero way to check other than
   triggering a real workflow.
2. It costs nothing extra to build correctly: the test endpoint should call the
   *same field-resolution helper* connectors.ts uses (if one doesn't exist as a
   standalone exported function today, extracting the `org?.x || process.env.X`
   three/four-line block per connector into a small shared resolver is a natural,
   low-risk refactor Nina can fold into her backend-review pass — it also removes
   duplicated logic between `connectors.ts` and the new test endpoint).
3. One caveat for the UI: when testing an env-var-fallback org (no vault row),
   the settings page should visually distinguish "testing your org's saved
   credentials" from "testing the deployment's shared default credentials" so an
   admin doesn't mistakenly believe they've configured an org-specific
   integration when they've actually just confirmed the shared fallback works.
   Suggested copy: "No org-specific credentials saved — this tested the
   deployment's default {connector} configuration."

---

## Open items / discrepancies for Rohan + Nina

1. **Slack's vault-enum inclusion is dead** (`CONNECTORS` in
   `workflowCredentials.ts` lists `slack` and `webhook`, but nothing reads
   `getCredentials(orgId, 'slack'|'webhook')`). Recommend Nina either (a)
   removes them from `CONNECTORS` to avoid a settings-page-writes-nothing-read
   trap, or (b) wires `notify.webhook`'s HMAC secret to read from the vault too
   (currently: need to confirm where the HMAC signing secret for
   `notify.webhook` actually comes from — not covered by this read, worth a
   follow-up check since it's adjacent to this settings page's scope).
2. **Slack test-connection route ownership** — proposed under
   `/api/notification-channels/slack/test` since that's where Slack's actual
   config lives, breaking the otherwise-uniform
   `/api/workflow-credentials/:connector/test` pattern for the other 4. Flagging
   for Nina to confirm rather than deciding unilaterally, since it's her route
   file.
3. **Salesforce token refresh** (§2) is a known gap, not solved by this form —
   recommend a backlog item, not a blocker for this settings page shipping.
4. Rohan's `INTEGRATIONS_SETTINGS_PAGE_SPEC.md` and Nina's
   `INTEGRATIONS_BACKEND_REVIEW.md` did not exist in `docs/automation-hub/` at
   the time this spec was written — cross-check against those once available;
   do not assume this doc silently supersedes either.
