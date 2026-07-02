# Integrations Settings Page — Concept Spec

**Author:** Rohan Desai (Principal Product Designer, Builder Experiences)
**Status:** Concept spec for direct implementation — no Figma access in this environment (prior
attempt hit a hard seat/tool-call limit). Written to the same precision as
`BUILDER_REDESIGN_V2_CONCEPT.md`, which was built from without ever touching Figma — this doc is
meant to carry the same weight.
**For:** David (integration engineer, connector field/Test-Connection behavior), Nina (backend,
API shape confirmation — see §4's explicit ask), and whichever frontend engineer builds this next.
**Scope:** Design only. No code in this document. Jira/Salesforce/ServiceNow/Zendesk/Slack only —
Prism ("Data Sources") is a named extension point (§6), not built here.

---

## 0. What I read before writing this, and what it told me

I read the full vault implementation before designing the page around it, specifically so I
wasn't inventing a UI for a data model that doesn't match reality — same discipline as the
builder redesign.

**`backend/src/lib/workflowCredentials.ts`.** `CONNECTORS = ['jira', 'salesforce', 'servicenow',
'zendesk', 'slack', 'webhook']` — six connector names known to the vault type system, but `slack`
credentials are never actually written through this vault (see below) and `webhook` has no
per-connector settings UI need (webhooks are configured per-workflow action, not as an org-level
credential — I'm excluding `webhook` from this page's card grid for that reason; flagged in §1).
Credentials are AES-256-GCM encrypted at rest, keyed by `WORKFLOW_CREDENTIALS_KEY`. Three properties
that directly shape the UI:

1. **Decrypted secrets are never returned by any read path.** `listConfiguredConnectors()` returns
   only `{ connector, createdAt, updatedAt }` — never the blob, never decrypted fields. This is a
   hard constraint, not a caching gap to route around: **the UI can never show a real credential
   value back to a user, ever, even the user who just typed it in and refreshed the page.** §3
   designs around this directly.
2. **Org-credentials-first-then-env-var-fallback is invisible to this page.** `connectors.ts`'s
   `jiraCreateIssue` etc. read `org?.baseUrl || process.env.JIRA_BASE_URL` — so a deployment can be
   "working" via shared env vars while showing "Not connected" on this page for a given org. This
   is correct and intentional (per the module's own header comment: "orgs simply fall back to the
   shared env vars"), but it means **"Not connected" on this card must not be read by the admin as
   "this integration doesn't work for us"** — it means "this org hasn't set its own credentials;
   it may still be running on deployment-wide shared credentials." §5 handles this in copy.
3. **`setCredentials` throws if the vault key is unconfigured**, and the route maps that to a 503
   ("Credentials vault is not configured on this deployment"). This is a real, user-facing failure
   mode on a fresh/dev deployment, not just a wrapped error — §2 designs a specific empty/disabled
   state for it, not a generic error toast.

**`backend/src/routes/workflowCredentials.ts`.** Confirmed exact surface: `GET
/api/workflow-credentials` → `{ connectors: [{ connector, createdAt, updatedAt }] }` (list, not
per-connector fetch — there is no `GET /api/workflow-credentials/:connector`, so the frontend
cannot ever ask "what are jira's saved values," only "is jira configured, and since when"). `PUT
/api/workflow-credentials/:connector` body `{ data: Record<string, any> }` — the schema is
`z.record(z.string(), z.any())`, i.e. **no per-connector field validation happens server-side
today** (confirmed: `putSchema` doesn't branch on `connector`). That means field-shape correctness
(is `baseUrl` actually a URL, is `apiToken` non-empty) is a **frontend-only** guarantee until/unless
David adds per-connector zod schemas — I'm calling this out explicitly in §2 rather than assuming
validation exists somewhere I didn't find it. `DELETE /api/workflow-credentials/:connector` → 404
if nothing was configured, else `{ success: true }`.

**`backend/src/lib/connectors.ts`.** Read `jiraCreateIssue`, `salesforceUpdateContact`,
`servicenowCreateIncident`, `zendeskCreateTicket` in full. Each does `getCredentials(orgId,
connector)` first, destructures specific named fields, and falls back to a specific named env var
per field. That field list **is** the form spec — I did not invent field names, I read them off the
destructuring:

| Connector | Fields read (exact keys) | Env var fallback |
|---|---|---|
| Jira | `baseUrl`, `email`, `apiToken`, `projectKey` | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` |
| Salesforce | `instanceUrl`, `accessToken` | `SF_INSTANCE_URL`, `SF_ACCESS_TOKEN` |
| ServiceNow | `instanceUrl`, `user`, `password` | `SERVICENOW_INSTANCE_URL`, `SERVICENOW_USER`, `SERVICENOW_PASSWORD` |
| Zendesk | `subdomain`, `email`, `apiToken` | `ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`, `ZENDESK_API_TOKEN` |

Notably: **Jira requires 4 fields to do anything at all** (`if (!baseUrl || !email || !token ||
!projectKey) return skipped`), so a Jira card cannot report "Connected" on a partial save — the
form's Save button and the card's status logic both need to treat these 4 as jointly required, not
independently optional. Salesforce's `accessToken` is a bare OAuth access token, not a
refresh-token flow — worth flagging to David/Nina as a likely future problem (access tokens expire;
there's no refresh mechanism visible anywhere in this module), but out of scope for this spec to
solve — I'm noting it so it isn't silently designed around.

**`backend/src/lib/channels.ts`'s `sendSlack`.** Confirmed independent mechanism: reads from
`notification_channels` table (`WHERE channel_type = 'slack' AND is_active = TRUE`), pulls
`config.webhook_url` — a single incoming-webhook URL, most-recently-created row wins
(`ORDER BY created_at DESC LIMIT 1`). This is genuinely a different shape from the other 4
connectors: one URL field, not multiple named credential fields, and it's read from a table that
also presumably backs *other* notification channel types (`email`, maybe future ones), not
exclusively Slack. §4 designs the illusion and names the exact API gap for Nina.

**`app/src/pages/SettingsConnectionsPage.tsx`.** This is my primary interaction reference, per the
brief. Concretely reusable: the `PROVIDER_META`-style badge map (fixed initials + brand color per
provider, rendered as a rounded-xl colored square), the glass-card visual language
(`background: rgba(255,255,255,0.72)`, `backdropFilter: blur(32px) saturate(180%)`, soft border +
shadow), the `NewConnectionModal`'s step-header pattern (numbered circles, checkmark on completed
steps, connecting line), the empty-state pattern (icon in a gradient rounded square, gradient-text
heading, one CTA), and the `syncConnections.*` locale namespace convention (nested by
provider/modal/schedule/status). **Not reusable as-is:** that page's data model is
config-per-provider (a user can create N named HubSpot connections, each with a mapping/schedule);
mine is fixed-connector (exactly 5 named integrations, one credential set per org per connector,
no user-defined naming, no field mappings, no schedule). So I'm reusing the *visual system* and the
*step-modal interaction pattern* wholesale, but the *data shape* is deliberately simpler — cards
map 1:1 to `CONNECTORS` entries, not to a fetched list of user-created rows.

---

## 1. Information architecture

### Page identity

New page: **Integrations** (not "Connections" — reserving "Connections" for the existing CRM
sync page's established meaning; using a different word avoids two same-named-different-thing
pages in the same product, which the sibling page's existing name already occupies).

- Route: `ROUTES.SETTINGS_INTEGRATIONS = '/app/settings/integrations'`, registered in
  `app/src/constants/routes.ts` next to `SETTINGS_CONNECTIONS`/`SETTINGS_TAGS`/`SETTINGS_OWNERSHIP`
  (same flat-under-`/app/settings/*` convention those already use — no new nesting level).
- Component: `app/src/pages/settings/IntegrationsSettingsPage.tsx` (in `pages/settings/`, matching
  `TagsSettingsPage.tsx`/`ProvisioningPage.tsx`'s location — **not** alongside
  `SettingsConnectionsPage.tsx`, which lives directly in `pages/` as a historical artifact; new
  settings sub-pages belong in the `settings/` subfolder per the newer files there).
- Permission gate: `workflows:manage` (same permission `routes/workflowCredentials.ts` already
  requires server-side) — mirror `TagsSettingsPage`'s `if (!isAdmin)` early-return pattern, but
  check the specific permission via `usePermissions()`, not the blanket `isAdmin` flag, since
  `workflows:manage` is a named permission in `backend/src/types/index.ts`'s permission catalog,
  not necessarily identical to "is an org admin" (confirm the exact frontend permission-check
  helper name with whoever owns `lib/permissions.ts`'s non-admin permission checks, if one exists
  beyond `isAdmin` — if only `isAdmin` exists client-side today, gate on that and let the backend
  403 be the real enforcement, consistent with how `TagsSettingsPage` already does it).

### Section structure — the extensibility-driving decision

The page body is a **vertical stack of named category sections**, not a single flat grid and not
tabs. This is the one structural decision everything else in this spec, and the entire Prism
extension point in §6, depends on — so I'm stating it plainly up front:

```
Integrations
├── Section: "Workflow Actions"        ← built now
│    [Jira card] [Salesforce card] [ServiceNow card] [Zendesk card] [Slack card]
│
└── (future) Section: "Data Sources"   ← NOT built now, see §6
     [Prism-connector cards...]
```

**Why sections-in-a-stack, not tabs:** tabs hide content behind a click and imply mutual exclusivity
("you're either looking at Workflow Actions or Data Sources") — wrong model here, since an admin
configuring integrations plausibly cares about both categories in one visit and scanning is cheap
when there are only 5-10 cards per section. A stacked-sections page lets a search/filter bar (if
ever needed) work across both categories at once, and it means adding "Data Sources" later is
**purely additive markup** — a new `<CategorySection>` appended after the existing one — with zero
restructuring of `IntegrationsSettingsPage`'s top-level JSX. Tabs would have required deciding
*now* whether Prism gets its own tab, its own route, or folds into an existing one — precisely the
kind of decision the brief says not to make yet. Sections-in-a-stack defers that decision correctly:
it's already answered ("its own tab" was never on the table).

**Section heading treatment:** each `<CategorySection>` is `{ title, subtitle, icon, cards[] }` —
title as a `text-base font-bold` heading (matching `SettingsConnectionsPage`'s "Configured
Connections" heading weight), subtitle as one muted sentence explaining what the category is for
("Connect the tools your automations can act on" for Workflow Actions), icon as a small leading
icon next to the title (not a badge — reserve colored badges for the per-connector cards
themselves, so the section heading stays visually quieter than its contents).

### Card grid

Below each section heading: `grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4` — 5 cards
(Jira/Salesforce/ServiceNow/Zendesk/Slack) wrap across up to 3 columns on wide viewports, matching
the responsive grid conventions used throughout `app/src/pages/settings/` (`TagsSettingsPage` uses
the identical `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` shape). Cards render in a fixed order
(Jira, Salesforce, ServiceNow, Zendesk, Slack — alphabetical-ish but Slack last since it's visually
"the odd one out" internally even though it must look identical externally; putting it last avoids
it "anchoring" the reading order as if it's the primary/default integration). Order is **not**
reordered by connection status (no "connected ones float to top") — stable ordering matters more
than status-sorting here since admins revisit this page rarely and benefit from muscle-memory
position over time.

### Per-card contents

Each connector card (reusing the glass-card style: `rgba(255,255,255,0.72)` bg,
`blur(32px) saturate(180%)`, soft border/shadow, `rounded-2xl` per this page's own visual scale —
one step up from `SettingsConnectionsPage`'s `1rem` since these cards carry more content):

```
┌──────────────────────────────────────────┐
│ [Badge]  Jira                    [●status]│
│          Create and update issues          │
│                                             │
│          Connected as jira.mycompany.com   │  ← only when connected; see §3
│          Configured 3 days ago             │  ← only when connected
│                                             │
│                          [ Connect ▸ ]     │  ← primary action, right-aligned
└──────────────────────────────────────────┘
```

- **Badge**: 40×40 `rounded-xl` colored square with connector initials, exact pattern lifted from
  `ProviderBadge`/`PROVIDER_META` in `SettingsConnectionsPage.tsx`. New `INTEGRATION_META` map (see
  §7 for exact values) — distinct from `PROVIDER_META` since `SyncProvider` (`hubspot | salesforce |
  csv_url | webhook`) and this page's connector set overlap only on the word "salesforce" but refer
  to conceptually different integrations (CRM contact sync vs. workflow action) that happen to share
  a vendor — **do not** reuse `PROVIDER_META`'s Salesforce entry; define a new, separate one, even
  though the badge may render identically, because the two pages' Salesforce integrations are
  unrelated (different credentials, different backend, different purpose) and coupling their color
  constants would be an accidental dependency between unrelated features.
- **Name + one-line description**: name is the connector's display label ("Jira", "Salesforce",
  "ServiceNow", "Zendesk", "Slack"); description is a single plain-English sentence describing what
  the automation feature does with it — not marketing copy, functional copy: "Create and update
  issues from workflow actions," "Update contact records when a workflow runs," "Create incidents
  from workflow actions," "Create support tickets from workflow actions," "Post automation
  notifications to a channel." This mirrors the plain-English-description discipline from the
  builder redesign's `TriggerTile`/`ActionTile` (§4 of that doc) — every configurable thing gets an
  honest one-line description of its actual behavior, not its category name repeated.
- **Status indicator**: top-right of the card header, a small colored dot + label — see §1.1 below
  for the exact 3-state model. This is the second-most-important piece of information on the card
  after the connector identity, so it sits in the header row, not buried lower.
- **Connected-state metadata line(s)**: when connected, up to two small muted lines beneath the
  description — a connector-specific "connected as" identifier (see table in §1.1) and a relative
  "Configured Nd ago" from `updatedAt` (reuse `SettingsConnectionsPage`'s existing
  `formatRelativeTime` helper verbatim — it's already generic, not sync-specific). When
  not-connected, these two lines are simply absent (not shown as empty/placeholder) — absence itself
  is part of communicating "nothing configured yet."
- **Primary action**: bottom-right of the card, a single button whose label depends on status (see
  §1.1). No overflow/kebab menu on the card face — Disconnect lives inside the edit flow (§3), not
  as a separate card-level icon button, because a destructive action for a credential that other
  running workflows may depend on deserves the deliberate friction of "open the panel, then
  disconnect," not a one-click kebab item next to Edit.

### 1.1 The three-state status model

Every card is in exactly one of three states, each with its own dot color, label, and primary
action:

| State | Dot | Label | Primary action | When |
|---|---|---|---|---|
| **Not connected** | gray, `rgba(100,116,139,0.4)` | "Not connected" | **Connect** | No row for `(org, connector)` in the vault (Jira/SF/SN/Zendesk) or no active `slack` `notification_channels` row (Slack) |
| **Connected** | green, `#059669` (same emerald used by `StatusChip`'s `completed` state) | "Connected" | **Edit** | Row exists; last Test Connection (if ever run) succeeded, or no test has been run yet since save (optimistic — see note below) |
| **Connection error** | red, `#dc2626` (same as `StatusChip`'s `failed`) | "Connection error" | **Reconnect** | The most recent Test Connection attempt failed, OR (Slack only, see §4) the webhook is configured but a live send genuinely failed |

**Important honesty note on "Connected":** because there is no background health-check job implied
by anything I read in `workflowCredentials.ts` or `connectors.ts` — no scheduled re-validation, no
webhook-based status push — "Connected" on this page means **"credentials are saved,"** not
**"credentials are currently verified working."** This is the same honesty concern as the
env-var-fallback point in §0: I'm not designing a lie into the status dot. The subtext under
"Connected" should say **"Connected · verified {time}"** if a Test Connection was ever successfully
run (persisted client-visibly via the card refetch after Test, or — better, flag to Nina — a
`last_tested_at`/`last_test_status` pair added to the vault's metadata so this survives a page
reload; today's `listConfiguredConnectors()` returns only `createdAt`/`updatedAt`, which conflates
"saved" with "verified" and can't distinguish them). If Nina can't add that column now, the fallback
copy is just **"Connected"** with no verified-time claim — still honest, just less informative.
I'm flagging the desired column addition here rather than assuming it exists.

**Connection error** requires a client-side signal since the vault has no server-persisted health
state today (per the above) — realistically this state is reachable in two ways: (a) the user just
ran Test Connection in the edit panel and it failed, session-scoped, remembered only until the page
reloads/refetches; or (b) (Slack only) the last real `sendSlack` dispatch attempt failed and that
gets surfaced back to this page — which needs its own small backend surface (not the credentials
vault at all) to report the org's most recent Slack delivery outcome. I am **not** requiring (b) for
v1 — flag it as a nice-to-have; v1 can ship with error-state only reachable via (a), and Slack
always resolves to Connected/Not-connected only (§4 covers this explicitly).

---

## 2. Per-connector configuration flow

### Modal, not inline expand

Clicking **Connect** (or **Edit**/**Reconnect**) opens a **modal dialog**, not an inline card
expansion. Reasoning, by contrast with the builder redesign's inline-step-panel choice: the builder
chose inline expansion specifically because the *sentence above it* needed to stay visible as
permanent context while editing a blank. Nothing analogous exists here — a credentials form has no
parent "sentence" it's illustrating, and inline-expanding a card in a multi-card grid pushes every
card below it down the page, which is disorienting when there are 5 cards in a 3-column grid (the
whole grid reflows, not just one row). A modal keeps the grid stable underneath and matches this
codebase's own established convention for this exact kind of task
(`SettingsConnectionsPage`'s `NewConnectionModal` already solves "configure a named
integration/credential set" as a modal, not an inline card).

### Structure: single-step, not `NewConnectionModal`'s 4-step wizard

`NewConnectionModal` is 4 steps (Provider → Config → Field Mappings → Schedule) because its data
model genuinely has 4 independent decisions to make for a new connection. This page's connectors
have **no field mappings and no schedule** — those concepts don't exist for Jira/Salesforce/
ServiceNow/Zendesk/Slack workflow-action credentials. So the modal is **single-step**: one screen,
the provider is already implied by which card's Connect button was clicked (no "choose a provider"
step needed — that's the card grid itself, already resolved), and the only content is the
credential form for that one connector. No step-header/progress-dots UI at all — reserve that
pattern for genuinely multi-step flows; a single-step modal that fakes a 1-of-1 progress indicator
would be visual noise per the same "don't build UI for a decision that isn't there" discipline as
the rest of this doc.

Modal header: `{ConnectorBadge} Connect Jira` (Connect/Edit/Reconnect + connector name, matching
whichever action opened it) with a one-line subtitle restating the plain-English description from
the card ("Create and update issues from workflow actions").

### Per-connector field specs

All fields render via shadcn `Input` + `Label`, same `rounded-xl` / `rgba(42,75,217,0.04)`
background / `1px solid rgba(42,75,217,0.15)` border treatment `NewConnectionModal` already uses,
for visual continuity between the two "configure an integration" surfaces even though their
step-structures differ.

**Jira**

| Field | Key | Input type | Placeholder | Notes |
|---|---|---|---|---|
| Base URL | `baseUrl` | text (`type="url"`) | `https://yourcompany.atlassian.net` | Inline validation: must be a well-formed URL (`new URL()` parse without throwing); trim trailing slash before send (connector already does `.replace(/\/$/, '')` server-side, but stripping client-side too avoids a confusing round-trip where what's saved differs visually from what was typed) |
| Email | `email` | text (`type="email"`) | `you@yourcompany.com` | Inline validation: basic email shape regex; this is the Atlassian account email used for Basic Auth, not a notification address — label it "Atlassian account email" not just "Email" to avoid the ambiguity |
| API Token | `apiToken` | password-masked | — | See §3 for masking-on-edit behavior; helper link/text below field: "Create a token at id.atlassian.com/manage-profile/security/api-tokens" (plain text + external link icon, not a hyperlink styled as body text, so it's visibly "leaves the app") |
| Project Key | `projectKey` | text, uppercase-on-blur | `ENG` | Inline validation: non-empty, warn (not block) if lowercase since Jira project keys are conventionally uppercase — auto-uppercase the field's displayed value on blur rather than rejecting lowercase input, since silently "fixing" casing is friendlier than erroring on it |

All 4 fields required — Save is disabled until all 4 are non-empty and pass their inline validation
(this directly reflects `jiraCreateIssue`'s all-four-or-skip behavior confirmed in `connectors.ts`
— shipping a form that lets 3-of-4 save would create a card that says "Connected" but silently
no-ops every Jira action, which is exactly the kind of honesty gap this whole spec is trying to
avoid).

**Salesforce**

| Field | Key | Input type | Placeholder | Notes |
|---|---|---|---|---|
| Instance URL | `instanceUrl` | text (`type="url"`) | `https://yourorg.my.salesforce.com` | Same URL validation as Jira's baseUrl |
| Access Token | `accessToken` | password-masked | — | Helper text beneath: "A Salesforce OAuth access token. Note: tokens expire — you may need to reconnect periodically." This is an honest caveat given §0's flag that no refresh-token flow exists; better to say so than let an admin discover it via a silent future failure |

Both required.

**ServiceNow**

| Field | Key | Input type | Placeholder | Notes |
|---|---|---|---|---|
| Instance URL | `instanceUrl` | text (`type="url"`) | `https://yourinstance.service-now.com` | Same URL validation |
| Username | `user` | text | — | |
| Password | `password` | password-masked | — | Basic-auth password, not an API token (ServiceNow's REST Table API here uses plain Basic Auth per `connectors.ts`) — label plainly as "Password" rather than implying it's a token, since the field genuinely is a login password and the UI shouldn't imply otherwise |

All 3 required.

**Zendesk**

| Field | Key | Input type | Placeholder | Notes |
|---|---|---|---|---|
| Subdomain | `subdomain` | text | `yourcompany` | Inline validation: no `.`/`/`/protocol allowed (it's just the subdomain segment, not a full URL — `connectors.ts` builds `https://${subdomain}.zendesk.com` itself); show a live preview beneath the field: "Tickets will be created at yourcompany.zendesk.com" so the user can visually confirm they typed the segment, not a full URL, before saving |
| Email | `email` | text (`type="email"`) | `you@yourcompany.com` | The Zendesk agent email used for `email/token:` Basic Auth |
| API Token | `apiToken` | password-masked | — | Helper link: "Create a token in Zendesk Admin Center → Apps and integrations → APIs → Zendesk API" |

All 3 required.

**Slack** — see §4 for its distinct single-field form (webhook URL only).

### Inline validation

Validation runs on blur (not on every keystroke — avoids the "red border while I'm still typing"
annoyance) and re-validates the whole form before enabling Save. Each field shows its own inline
error beneath it in the existing form-error convention (small red text under the field, e.g.
matching the destructive-color pattern already used in `CreateTagDialog`'s `err` display, applied
per-field here instead of once at the form bottom, since blank/malformed individual fields is the
dominant error mode for credential fields). No field-level validation calls the backend — this is
all client-side shape checking (well-formed URL, non-empty, email regex) since, per §0, the PUT
route does no server-side per-connector shape validation today; catching obviously-wrong input
client-side is the only guard that exists until David/Nina add server-side zod schemas per
connector.

### Test Connection

A **"Test Connection"** button sits at the bottom-left of the modal body (left-aligned, opposite
the Cancel/Save buttons which stay bottom-right per this codebase's existing dialog-footer
convention) — visually secondary (`variant="outline"`) since it's a helper action, not the modal's
primary commit action.

- **Enabled** once all required fields for that connector are filled and pass inline validation
  (same gate as Save's eventual enable condition) — disabled with the same greyed treatment
  otherwise, no need for a separate tooltip explaining why, the surrounding empty/invalid fields
  are self-explanatory.
- **Loading state:** button becomes a fixed-width spinner + "Testing…" (reuse the small
  `border-2 border-t-transparent animate-spin` spinner already used throughout this codebase's
  buttons, e.g. `ConfigCard`'s sync button), button and both fields' inputs disabled for the
  duration so a user can't edit mid-test and get a result that doesn't match what's now in the
  fields.
- **Success:** button flips to a green checkmark + "Connected" for ~2.5s, then reverts to its
  default "Test Connection" label (so re-testing after further edits is always available, it
  doesn't get stuck saying "Connected" forever). A thin green banner appears above the button row:
  "Connection verified — you can now save." This is deliberately calm, not a modal-stealing toast,
  since the user is still inside the modal and about to take the next action (Save) themselves.
- **Failure:** button flips to a red "Test failed" state for the same ~2.5s-then-revert treatment,
  and a red banner replaces the green one with the **specific reason if the backend provides one**
  (e.g. "401 Unauthorized — check your API token" / "Could not reach yourcompany.atlassian.net —
  check the base URL"), falling back to a generic "Couldn't connect — check your credentials and
  try again" if the backend only returns a bare failure. (David owns the actual HTTP-call contract
  behind this button — my ask of him: return enough structure, e.g. `{ ok: false, reason: string
  }`, that the UI can show *something* more specific than "it failed," since a bare failure with no
  reason is the single most frustrating credential-debugging experience and this page exists
  specifically to make third-party credential setup less error-prone than editing a raw `.env`
  file.)

### Save is allowed regardless of Test Connection result — recommendation, with reasoning

**Save is never blocked by Test Connection's outcome or absence.** A user can click Save having
never run Test Connection at all, or having run it and seen it fail, and Save still works (subject
only to the client-side field-shape validation in the previous section). Reasoning:

1. **Symmetry with today's env-var reality.** Nothing today validates `JIRA_API_TOKEN` etc. before
   the deployment "goes live" with it — env vars are just trusted. Requiring org-level credentials
   to pass a live test before saving would make the *safer, more auditable* path (per-org vault)
   *more restrictive* than the *less safe* path (shared env vars) it's meant to be an upgrade from.
   That's backwards incentive design — it would push cautious admins back toward "just ask IT to
   set the env var" instead of using the feature this page exists to expose.
2. **Test Connection can fail for reasons that aren't "these credentials are wrong"** — a
   corporate VPN/firewall blocking the outbound test call from wherever the backend runs, a
   transient 503 from Jira, a token that's valid but scoped to a different action than "create
   issue" (untestable without actually creating a throwaway issue, which David's Test-Connection
   design should almost certainly avoid doing). Hard-blocking Save on a possibly-environmental test
   failure would trap a user with genuinely-correct credentials.
3. A failed test is still surfaced loudly (red banner, and per §1.1 the card can reflect "Connection
   error" after save if the last known test result was a failure) — the goal is *informed consent*,
   not *enforced correctness*. The user sees the failure, understands the risk, and can still choose
   to save (e.g. "I know this token needs my IT team to whitelist a firewall rule first, but I want
   to save it now and worry about testing later").

This is a recommendation for David/Nina to confirm or push back on — if there's a strong reliability
reason to hard-gate (e.g. a bad save silently breaks every workflow using that connector with zero
warning until it fires), an alternative is a **soft gate**: Save remains clickable but shows a
one-time confirm-dialog ("You haven't verified this connection — save anyway?") only when Test
Connection was run and failed (not when it was never run at all, which shouldn't be penalized the
same as a known failure). I'd only reach for that if reliability data says naive full-block is
wrong to avoid — my default in this spec is the fully-permissive version above.

---

## 3. Credential masking and security UX

This section is the direct answer to the vault's core constraint from §0: **decrypted secrets are
never returned by any GET.** The UI must never imply it can show a saved secret back to the user.

### Editing an already-configured connector

Opening **Edit** on a Connected card opens the same single-step modal as Connect, but every
secret-bearing field (`apiToken`, `accessToken`, `password`) renders **pre-filled with a fixed
8-dot masked placeholder** (`••••••••`) that is **not editable text and not a real value** — it's a
visual placeholder occupying the field, not `type="password"` masking of an actual loaded value
(there is no value to load, per the vault's write-only design). Concretely:

- The field renders in a **read-only, visually "filled but locked" state**: the `••••••••` glyph
  string, a small lock icon at the field's trailing edge, and a **"Replace"** link/button
  immediately to the right of (or beneath, on narrow widths) the field.
- Clicking **Replace** turns that one field from locked-placeholder into a normal empty, editable,
  password-masked input — exactly like the Connect flow's blank field — with a small "Cancel"
  affordance next to it (an X or "Undo") that reverts it back to the locked placeholder state if the
  user changes their mind before saving.
- **Non-secret fields** (`baseUrl`, `email`, `projectKey`, `instanceUrl`, `subdomain`, `user`) are
  **not** masked at all on Edit — but they're also not pre-filled from a GET, because none exists
  (`GET /api/workflow-credentials` returns no field values, only connector names + timestamps, per
  §0). So on Edit, **every field — secret or not — starts without a known prior value.** This is a
  more significant honesty gap than just the secrets: right now, re-opening Edit on Jira gives the
  admin no way to see what base URL or project key they'd previously entered, even though those
  aren't secret at all.

**Design decision for non-secret fields on Edit — recommendation for Nina:** I'm recommending
`GET /api/workflow-credentials` (or a connector-scoped variant) be extended to return the **non-
secret fields' values** alongside the existing `{ connector, createdAt, updatedAt }` metadata — e.g.
`{ connector: 'jira', createdAt, updatedAt, nonSecretFields: { baseUrl, email, projectKey } }` —
while continuing to withhold `apiToken` entirely. This requires the vault to know, per connector,
which of its stored keys are "secret" vs. "identifying" (a small static map colocated with
`CONNECTORS`, e.g. `SECRET_FIELDS: Record<ConnectorName, string[]>`), decrypting the blob
server-side as it already does for `getCredentials`, and filtering the returned object to non-secret
keys only before sending it to the client. This is a real, scoped backend change, not a frontend
workaround — I'm flagging it here rather than pretending the frontend can synthesize it. **If Nina
decides this is out of scope for now,** the fallback UX is: every field on Edit (secret or not)
starts blank with a placeholder of *italicized, muted, non-monospace* text reading "Currently set —
enter a new value to change it" for non-secret fields (distinct visual treatment from the `••••••••`
lock-icon treatment on true secrets, since a blank base-URL field with no dots and no lock is a
different kind of "I can't show you this" than a masked token) — and the user must retype an
unrelated field's new value only if they intend to change it; leaving a field as this placeholder
and hitting Save must **not** overwrite that field with an empty string (see next paragraph).

### Partial-update semantics (a real backend constraint to flag)

Because `PUT /api/workflow-credentials/:connector` takes a full `data` object and (per
`setCredentials`) fully overwrites the stored blob (`INSERT ... ON CONFLICT DO UPDATE SET
encrypted_blob = EXCLUDED.encrypted_blob`) — **there is no partial-field-merge on the backend
today.** If the frontend Edit form only collects the fields the user actually touched and sends
just those, a Replace-only-the-token save would **wipe out `baseUrl`/`email`/`projectKey`** by
overwriting the blob with a partial object.

**This means the frontend must reconstruct the full payload on every Edit save**, not just the
changed fields — which is only possible if the non-secret fields' prior values are available to
re-send (hence the previous paragraph's ask to Nina) **or** if Nina instead adds a
merge-on-write behavior server-side (`setCredentials` reads the existing row, merges `data` on top
of it, then re-encrypts — a backend-only change, no new endpoint needed). **I'd recommend the
merge-on-write approach over the read-back-values approach** if Nina has to pick one: it's strictly
safer (impossible to accidentally wipe a field the UI simply forgot to resend) and it also sidesteps
ever needing to decide whether non-secret fields should be returned to the client at all. Either
fix resolves this; flagging both options for her to choose given backend realities I can't see from
here (e.g. whether other code depends on `setCredentials` being a hard overwrite).

**Until either fix ships**, the safe interim frontend behavior is: **Edit always requires
re-entering every field from scratch** (the modal opens with all fields blank, exactly like
Connect, no locked-placeholder / Replace affordance at all — that affordance is only safe to build
once one of the two backend fixes above exists). I'm specifying the fuller Replace-affordance UX
above as the target design, but calling out explicitly that **it should not ship until the
partial-update hazard is resolved on the backend**, since shipping it against today's overwrite
semantics would silently corrupt saved credentials the first time someone uses "Replace" on just
the token field.

### Disconnect

Inside the Edit modal (not on the card face, per §1), a **"Disconnect [Connector]"** link in
destructive red sits at the bottom-left of the modal, separate from and visually lighter-weight
than the Cancel/Save button pair (small text link, not a button) — clicking it opens a confirm
sub-dialog (reuse `ConfigCard`'s existing delete-confirmation `Dialog` pattern verbatim: red header
band, "This will stop workflow actions from using your Jira credentials. Workflows using Jira
actions will fall back to your organization's shared credentials, if configured, or fail." as the
body copy — this sentence is important: it tells the truth about the env-var fallback from §0
rather than implying Disconnect means "nothing will happen anymore"). Confirm calls `DELETE
/api/workflow-credentials/:connector`, closes both dialogs, refetches the card list.

---

## 4. Slack's dual-mechanism handling

### The illusion, precisely

From the card grid, Slack's card is visually and interactively **identical in shape** to the other
4: same badge-size, same status-dot vocabulary, same Connect/Edit/Reconnect button labels, same
modal chrome. The *only* difference the user should ever notice is that **Slack's modal has one
field, not three or four** — which is true to its actual simplicity (a webhook URL), not a
disguised complexity mismatch.

**Slack modal, single field:**

| Field | Key (client-side concept only) | Input type | Placeholder | Notes |
|---|---|---|---|---|
| Webhook URL | — (maps to `notification_channels.config.webhook_url`, not a vault key) | text (`type="url"`), NOT password-masked | `https://hooks.slack.com/services/...` | Not treated as a secret-masked field even though it is sensitive, because Slack incoming webhook URLs are conventionally displayed in setup UIs (Slack's own app-management UI shows them in plaintext) and because — importantly — **this value CAN be read back**, unlike the vault-backed connectors, since it lives in `notification_channels`, a table this page's read path can plausibly fetch directly (assuming Nina confirms; see below) |

Below the field: a "How to get this" disclosure/helper text: "In Slack, go to your workspace's App
Directory → Incoming Webhooks → Add to Slack, choose a channel, and copy the Webhook URL here." No
"Replace" masking dance needed for Slack's Edit flow (unlike §3's secret-field treatment) — if Nina
confirms the URL is readable server-side, Edit can simply pre-fill the real value, which is a
strictly better, more honest experience than the other 4 connectors get, and worth having since
Slack's mechanism allows it.

Test Connection for Slack does a real thing conceptually different from the other 4 (there's no
"read-only ping" for an incoming webhook — testing it necessarily posts a visible test message to
the real Slack channel). The button should be labeled the same ("Test Connection") for UI
consistency, but the success banner should say something slightly more specific: "Test message sent
— check #your-channel in Slack" rather than the generic "Connection verified," since a Slack test
has an observable side effect the other 4 don't, and hiding that would be a small dishonesty in the
name of surface-consistency that isn't worth it. This is a copy-only difference, not a structural
one — the button, states, and Save-not-blocked-by-test logic (§2) are otherwise identical.

### What I need from Nina — the exact API-shape question, with a recommendation

**The question:** does `GET /api/workflow-credentials` need to be extended to also report Slack's
status (and, per the paragraph above, its configured webhook URL), or does the frontend call two
separate endpoints (`GET /api/workflow-credentials` for the 4 vault connectors, plus something like
`GET /api/notification-channels?type=slack` for Slack) and **merge them client-side** into one
unified list of 5 card view-models?

**My recommendation: client-side merge, not a backend-unified endpoint.** Reasoning:

1. `workflow_connector_credentials` and `notification_channels` are legitimately different tables
   serving different concerns (the vault is workflow-action credentials; `notification_channels`
   is the org's general notification delivery config, which — per `channels.ts` — may already or
   later include non-Slack channel types like a future SMS or Teams channel that have nothing to do
   with workflow actions at all). Making `/api/workflow-credentials` reach into
   `notification_channels` to answer "is Slack set up" would blur that boundary at the API-contract
   level for a UI-only convenience, and it would mean this one route now depends on two unrelated
   tables' shapes forever.
2. A `GET /api/notification-channels` (or similarly-named) read endpoint almost certainly already
   exists or is trivial to add for Nina, independent of this page — Slack's own settings likely need
   to be readable somewhere already (even if only for the notification-preferences surface
   referenced in `channels.ts`'s comments). If such a route exists, the frontend merge is a two-call
   `Promise.all` on page load, trivial engineering, and zero backend coupling changes.
3. Client-side merge keeps `IntegrationsSettingsPage`'s frontend explicitly aware that Slack is
   "special" (it already has to be, per the brief — someone has to write the two different PUT/DELETE
   call shapes for Slack vs. the other 4 regardless of how GET is shaped) — so there's no real
   simplicity gained by hiding the two-table reality behind a fake-unified GET; the illusion only
   needs to hold at the **card-rendering** layer, not all the way down through every network call.

**Concretely, what I need from Nina:** confirm (a) the exact existing or new endpoint to
GET the org's current Slack `notification_channels` row (webhook URL + `is_active` + `updated_at`
at minimum — `created_at` too if available, to match the "Configured Nd ago" metadata line other
cards get), and (b) the exact PUT/DELETE shape to create/update/deactivate that row from this page
(does it reuse an existing `notification-channels` route, or does Slack from *this specific page*
need its own thin route so it doesn't collide with however the general notification-preferences UI
manages the same table?). If a collision risk exists — e.g. this page's "Disconnect Slack" instead
needs to *deactivate* rather than delete the row, in case some other preferences UI already depends
on that row's existence — flag that back to me, since it changes whether "Disconnect" is a DELETE
or a PATCH-to-inactive from the UI's perspective (functionally identical to the user; only the
network call shape differs).

**Frontend merge shape:** on page load, `IntegrationsSettingsPage` fires two requests in parallel
(`api.listWorkflowCredentials()` for the 4 vault connectors, `api.getSlackChannel()` — name TBD
with Nina — for Slack), and builds one `IntegrationCardViewModel[]` array combining both results
before rendering the grid, so every downstream component (`IntegrationCard`, the modal) only ever
sees the unified shape and never needs an `if (connector === 'slack')` branch outside of the two
places that structurally must know (the field-list-per-connector table in §2, and whichever API
function dispatches the PUT/DELETE to the right backend route). This containment is the actual
mechanism of "the illusion" — not hiding the truth from the codebase, just scoping how far the
truth needs to leak.

---

## 5. Empty/first-visit state, and the entry point

### Entry point in nav

This page is **not** added to the primary `SideNav` (per `SideNav.tsx`, the nav's top-level items
are feature areas — Surveys/Data/Prism/Insights/etc. — plus a single `nav.settings` item; a new
top-level nav entry for one settings sub-page would be disproportionate). Instead, two entry paths,
matching how `SettingsConnectionsPage` itself is discovered today (a contextual link from
`ContactsPage`, *not* a `BrandSettingsPage` tab — confirmed by reading both files: `ROUTES.
SETTINGS_CONNECTIONS` appears in `App.tsx`'s route table and in a `ContactsPage.tsx` link, never
inside `BrandSettingsPage.tsx`'s tab list):

1. **Contextual link from `WorkflowsPage.tsx`'s header actions row** — this is the primary,
   intended discovery path, exactly mirroring `ContactsPage`'s existing `ROUTES.SETTINGS_
   CONNECTIONS` link pattern (small pill-style link, `rgba(42,75,217,0.08)` bg,
   `var(--color-primary)` text, icon + label — `<Icon name="cable" />` "Integrations", or reuse
   whatever icon this page settles on for its own header). Placed in `WorkflowsPage`'s `PageHeader
   actions` slot, likely as a `variant="outline"` button alongside the existing NL-Builder/
   Build/Canvas buttons there, OR as a smaller secondary link if the header is already crowded (4
   buttons currently) — final placement is a frontend-engineer call at build time, not something
   this spec needs to pin down further; the requirement is just "reachable in one click from the
   Workflows list page," not a specific pixel position.
2. **Direct URL / breadcrumb from the page itself** — `PageHeader`'s `crumbs` prop:
   `[{ label: t('nav.workflows'), path: ROUTES.WORKFLOWS }, { label: t('integrationsSettings.
   title') }]` — treating this as conceptually a sub-page of the Workflows/Automation feature
   area (its breadcrumb parent is Workflows, not Settings) even though its route lives under
   `/app/settings/*` and it's gated the same way other Settings sub-pages are. This mirrors
   `TagsSettingsPage`'s crumb-to-`ROUTES.SETTINGS` pattern but substitutes Workflows as the more
   contextually relevant parent, since "which feature does this configure" (Workflows) is a more
   useful orientation than "which admin bucket is this filed under" (Settings) for a page an admin
   almost always arrives at *from* the Workflows page.

I'm deliberately **not** recommending adding this page to `BrandSettingsPage`'s tab list — that
component's tabs are broad admin categories (General/Team/Notifications/Admin/Roles/API Keys), and
"Integrations" doesn't cleanly nest under any of them without either creating a 7th tab (diluting
an already-dense tab bar) or awkwardly filing 5-connector-credential-management under
"Notifications" (wrong) or "Admin" (too vague). A contextual link from the feature that actually
consumes these credentials (Workflows) is both more discoverable in practice and consistent with
how this codebase already treats `SettingsConnectionsPage`.

### Empty / first-visit state

On first visit, **all 5 cards render in "Not connected" state simultaneously** — this is not a
distinct empty-state screen (unlike `SettingsConnectionsPage`'s big centered icon+heading+CTA empty
state, which fires when the *list* of user-created configs is literally zero-length). Here, the
grid itself **is** the content regardless of connection count — 0 connected, 3 connected, or 5
connected all render the identical 5-card grid, just with different per-card states. This is a
deliberate departure from the sibling page's pattern, justified by the differing data model
(§0/brief already called this out: fixed 5 connectors vs. a dynamic user-created list) — there is
no "zero state" to special-case because the set of possible cards never grows or shrinks; only
individual cards' status changes. So:

- **Page-level empty state exists, but it's a banner, not a full-page takeover.** Above the "Workflow
  Actions" section heading, when **zero** of the 5 are connected, show a single dismissible-per-
  session info banner (not a persistent nag — dismiss via localStorage flag keyed per-org, same
  spirit as any other one-time hint banner elsewhere in the app): "Connect at least one integration
  to let your workflows create tickets, update records, or post notifications automatically." with
  a small illustrative icon, no CTA button of its own (the 5 Connect buttons below it are already
  the CTAs — a banner-level duplicate "Get started" button would be redundant).
- **Vault-unconfigured-deployment state** (per §0's point 3 — `WORKFLOW_CREDENTIALS_KEY` unset,
  every PUT returns 503): if the **first** PUT attempt on this page ever returns that specific 503,
  replace the info banner (not each individual card — the banner is the right altitude for a
  deployment-wide condition) with a distinct amber warning banner: "The credentials vault isn't
  configured on this deployment yet. Contact your platform administrator." and **disable every
  card's Connect/Edit button** (grayed, with a tooltip repeating the same message) rather than
  letting each card independently discover and report the same 503 one at a time — this is a
  deployment-level fact, not a per-connector fact, and should read as one. Detecting this proactively
  (rather than waiting for a failed PUT) would require a dedicated capability-check endpoint I didn't
  find evidence of in the routes I read — flag to Nina as a nice-to-have (`GET
  /api/workflow-credentials/status` or similar returning `{ vaultConfigured: boolean }`) so this
  banner can render correctly on page load instead of only after a user's first failed save attempt;
  until that exists, the reactive (post-failed-PUT) version above is the honest fallback.

---

## 6. Extensibility for Prism ("Data Sources") — design constraint only, not scope

**Not built now.** This section exists solely so the IA decision in §1 is legible as intentional,
and so whoever eventually builds Prism's connector settings has a documented seam to build into
rather than rediscovering one.

When Prism's OAuth+Secret-Manager-backed connections are ready for a settings surface, the addition
is:

1. **A second `<CategorySection>`** appended to the same `IntegrationsSettingsPage`, titled "Data
   Sources," subtitle along the lines of "Connect the systems Prism ingests experience data from."
   Structurally identical to "Workflow Actions" — a title/subtitle/icon header, then a card grid
   below it — because `<CategorySection>` was built generic from day one (props: `title, subtitle,
   icon, children` wrapping arbitrary card content), not hardcoded to the 5-connector vault model.
2. **Prism's cards do not have to share this page's Connect/Edit modal component.** Because Prism's
   connections are OAuth-flow-initiated (redirect-based, per the brief) rather than
   paste-your-token-here form-based, its cards' primary action ("Connect") can trigger a completely
   different interaction (an OAuth redirect/popup) while still rendering as a visually-consistent
   card in the same grid system — the card-level visual contract (badge, status dot, one-line
   description, primary action button) is the only thing that needs to be shared; the *behavior*
   behind the button is already designed to be swappable per-section, not universal. This is
   exactly why §1 modeled sections as a list of `{ title, subtitle, icon, cards[] }` rather than a
   single global "all cards share one modal" assumption.
3. **No change to this page's route, permission gate, or entry point.** Prism connections may
   reasonably warrant their *own* `requiredPermission` distinct from `workflows:manage` (a
   data-ingestion permission, not a workflow-automation one) — if so, the permission check moves
   from page-level (`if (!hasPermission('workflows:manage')) return <Denied />`) to
   section-level (`<CategorySection requiredPermission="...">` conditionally rendering its own
   cards), which is a small, contained change to `<CategorySection>`'s props, not a page
   restructuring.
4. **No locale-namespace collision** — see §7; Prism's strings would live under their own
   `dataSourcesSettings.*` (or similar) namespace from day one, never crowding
   `integrationsSettings.*`.

The single concrete thing this spec asks today's implementation to get right so step 1 above stays
true: **build `<CategorySection>` as its own small reusable component from the start** (not inline
JSX repeated once because "there's only one section right now") — that's the entire cost of keeping
this door open, and it's cheap enough that there's no reason to defer it.

---

## 7. Locale key namespace

New namespace: **`integrationsSettings.*`** — distinct from `syncConnections.*` (the sibling CRM
page) and `workflows.*` (the workflow builder/list feature), per the brief's explicit ask, since
this page is neither of those two features even though it's adjacent to both.

Proposed top-level shape (illustrative, not exhaustive — final key list is the implementing
engineer's to fill in as components are built, following this file's existing nesting-by-concern
convention):

```
integrationsSettings: {
  title: 'Integrations',
  subtitle: 'Connect the tools your automations can act on',
  sections: {
    workflowActions: {
      title: 'Workflow Actions',
      subtitle: 'Connect the tools your automations can act on',
    },
    // dataSources: { ... }  ← added later, Prism's own keys, not reserved/stubbed now
  },
  connectors: {
    jira:       { label: 'Jira',       description: 'Create and update issues from workflow actions' },
    salesforce: { label: 'Salesforce', description: 'Update contact records when a workflow runs' },
    servicenow: { label: 'ServiceNow', description: 'Create incidents from workflow actions' },
    zendesk:    { label: 'Zendesk',    description: 'Create support tickets from workflow actions' },
    slack:      { label: 'Slack',      description: 'Post automation notifications to a channel' },
  },
  status: {
    notConnected: 'Not connected',
    connected: 'Connected',
    connectedVerified: 'Connected · verified {time}',
    connectionError: 'Connection error',
  },
  actions: {
    connect: 'Connect',
    edit: 'Edit',
    reconnect: 'Reconnect',
    disconnect: 'Disconnect {connector}',
    testConnection: 'Test Connection',
    testing: 'Testing…',
    testSucceeded: 'Connected',
    testFailed: 'Test failed',
  },
  fields: {
    baseUrl: 'Base URL',
    email: 'Atlassian account email',       // per-connector overrides where the label differs
    apiToken: 'API Token',
    projectKey: 'Project Key',
    instanceUrl: 'Instance URL',
    accessToken: 'Access Token',
    user: 'Username',
    password: 'Password',
    subdomain: 'Subdomain',
    webhookUrl: 'Webhook URL',
  },
  masking: {
    replace: 'Replace',
    cancelReplace: 'Cancel',
    currentlySet: 'Currently set — enter a new value to change it',
  },
  emptyState: {
    banner: 'Connect at least one integration to let your workflows create tickets, update records, or post notifications automatically.',
    vaultUnconfigured: "The credentials vault isn't configured on this deployment yet. Contact your platform administrator.",
  },
  disconnectConfirm: {
    title: 'Disconnect {connector}',
    body: 'This will stop workflow actions from using your {connector} credentials. Workflows using {connector} actions will fall back to your organization\'s shared credentials, if configured, or fail.',
  },
}
```

Field labels are mostly shared across connectors (`apiToken`, `instanceUrl` etc. reused verbatim
where the concept is identical), with per-connector override only where the same key means
something meaningfully different in context (Jira's `email` is specifically "Atlassian account
email," not a generic email field) — implementer's call whether that's modeled as
`fields.jira.email` overrides or a single flat `fields.email` reused everywhere with connector name
substituted via `t()` interpolation; either is consistent with this file's existing mixed
patterns (`syncConnections.modal.*` is flat, `syncConnections.providerDescriptions.*` is keyed by
provider) — I'd lean flat-with-interpolation for the 90% of fields that are truly generic, and only
break out a connector-specific override for the couple of fields (`email` on Jira/Zendesk having
different implied context) where interpolation alone wouldn't clarify it.

---

## 8. Summary of open items for David and Nina

For **David** (integration engineer):
- Confirm the exact Test Connection API contract per connector — my ask: return `{ ok: boolean,
  reason?: string }` (or equivalent) so the UI can show a specific failure reason, not just
  pass/fail (§2).
- Confirm whether Test Connection performs a fully read-only check for all 4 REST-based connectors,
  or whether any of them (Jira in particular) can only be verified by a call that has a side effect
  — affects whether the success/failure copy needs the same "this had a visible side effect" caveat
  Slack's does (§4).
- Confirm the per-connector field lists in §2 against reality — I derived them by reading
  `connectors.ts`'s destructuring, but David may know of fields that exist in the vault schema but
  aren't yet read by the connector functions (e.g. future OAuth scopes), or additional optional
  fields worth exposing (e.g. Jira issue-type default, currently hardcoded to `config.issueType ||
  'Task'` per-workflow-action rather than per-org-credential — confirm this should stay a
  per-workflow-action field, not move to this settings page, since it's workflow-config not
  credential-config; my read is it correctly stays out of scope here).

For **Nina** (backend):
- **Slack GET/PUT/DELETE shape** (§4) — confirm existing or new endpoint(s) to read/write/deactivate
  the org's Slack `notification_channels` row from this page, and whether Disconnect should DELETE
  or deactivate given potential shared use of that table by other notification UI.
- **Partial-update hazard** (§3) — `setCredentials` fully overwrites the blob; recommend adding
  merge-on-write server-side (preferred) or extending `GET` to return non-secret field values so the
  frontend can reconstruct a full payload on Edit. Either unblocks the "Replace just the token"
  UX; without one of them, Edit must require re-entering every field from scratch as an interim
  safety measure.
- **`last_tested_at`/`last_test_status` metadata** (§1.1) — nice-to-have addition to the vault's
  non-secret metadata so "Connected · verified {time}" survives a page reload instead of being
  session-only.
- **Vault-capability-check endpoint** (§5) — nice-to-have `GET
  /api/workflow-credentials/status` → `{ vaultConfigured: boolean }` so the unconfigured-deployment
  banner can render proactively on page load rather than only after a user's first failed save hits
  a 503.
- Confirm the frontend-side permission check (`workflows:manage` vs. a broader `isAdmin`) — §1.
