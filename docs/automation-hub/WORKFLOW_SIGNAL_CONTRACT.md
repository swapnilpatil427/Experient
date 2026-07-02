# Workflow Signal Contract — CrystalOS ↔ Backend (Wave 3, Phase 3 AI Triggers)

**Author:** Nina Reeves (Senior Engineer, Platform Integration and Architectural
Integrity), per TEAM.md's mandate: "Define the `workflow_signal` contract between
CrystalOS insight pipeline output and the backend trigger evaluator" and "Act as
integration owner for Phase 3 (AI triggers) — sign off before CrystalOS → backend
seam ships."
**Status:** Backend side implemented and tested. **CrystalOS side (Amara Osei)
has now landed** — see "§6. Amara's reconciliation pass" at the bottom of this
document for what was verified/corrected against Nina's assumptions above. The
sections above this line are preserved as originally written (Nina's working
contract, authored before CrystalOS code existed) — do not edit them
retroactively; §6 is the reconciliation record.

---

## 0. Reconciliation status — read this first

Per the brief for this work: "check whether she's finished and look for her
summary/report and `docs/automation-hub/WORKFLOW_SIGNAL_CONTRACT.md` before
finalizing your side — if her endpoint path or request/response shape differs
even slightly from what's below, match HER actual implementation... since
briefs are written before the work happens and reality wins."

I checked. As of this writing:
- `crystalos/` has no route, skill, or module referencing `parse-nl`,
  `parse_nl`, `workflow_signal`, `sentiment_spike`, or `new_theme_detected`
  (`grep -rli` across the whole tree returned nothing).
- `git log --oneline -- crystalos/` shows no Wave 3 commit — the most recent
  CrystalOS-touching commit is the Prism W1 ingestion pipeline, unrelated to
  workflows.
- This file did not exist before I wrote it.

**Conclusion: Amara's Wave 3 CrystalOS work has not started (or not landed)
yet.** Per the brief's fallback instruction, I proceeded against
`BUILDER_SPEC_WAVE2.md §2.1` (the NL-parse contract) and my own mandate (the
`workflow_signal` contract, which TEAM.md assigns to me to *define*, not to
Amara) as the working assumptions below. **This is not yet a confirmed
cross-team contract** — it is the backend's half, built to be easy to reconcile
against once CrystalOS code exists. See §5 (Sign-off) for exactly what must be
re-verified when Amara's implementation lands.

---

## 1. Seam 1 — `POST /api/workflows/parse-nl` (Express → CrystalOS, outbound)

### 1.1 Frontend-facing contract (already built, do not change)

`app/src/pages/WorkflowNLBuilderPage.tsx` and `app/src/lib/api.ts`'s
`parseWorkflowNL()` already call this route today and handle its response
gracefully. This shape is **fixed** — changing it requires updating the
frontend, which is out of scope for this wave (Amara/backend-only).

```
POST /api/workflows/parse-nl
Auth: requireAuth + requirePermission('workflows:manage')
Request:  { description: string }              // 1–1000 chars
Response 200:
{
  name: string, description: string, triggerType: string,
  nodes: EngineNode[], edges: EngineEdge[],
  confidence: number,                            // 0–1
  warnings: string[],
}
Response 422: { error: 'unparseable', message: string, suggestions: string[] }
Response 504: { error: string }                  // generic envelope, no special shape
```

### 1.2 Backend implementation (this wave, Nina)

- `backend/src/routes/workflows.ts` — new `POST /parse-nl`, gated identically
  to every other route in the file (`requireAuth` +
  `requirePermission('workflows:manage')`), validated via a new Zod schema
  (`parseWorkflowNLSchema` in `backend/src/schemas/workflows.ts`, `description`
  1–1000 chars).
- `backend/src/lib/agentsClient.ts` — new `parseWorkflowNL(description,
  registryPayload, orgId)`. Posts to CrystalOS at a path held in the exported
  const `PARSE_WORKFLOW_NL_PATH = '/workflows/parse-nl'` (mirrors the existing
  `MANUAL_INSIGHT_RUN_PATH`/`CUSTOM_ANALYSIS_RUN_PATH` pattern of holding
  not-yet-confirmed paths as named consts specifically so they're a one-line
  fix later). **This path is a placeholder, not a confirmed CrystalOS route —
  see §0.** Body sent: `{ org_id, description, registry }` — `registry` is the
  live `workflowRegistry.ts` catalog (`registry()`'s output: triggers,
  conditionFields, conditionOperators, actions) so CrystalOS validates
  `triggerType`/actions against the single source of truth rather than
  hardcoding its own copy (root `CLAUDE.md`'s "CrystalOS proposes... the
  backend is the bridge" pattern — the registry IS the bridge's contract
  here). Uses `LLM_TIMEOUT_MS` (90s) — same class of call as `refineRun`/
  `addSkipLogic`/`applyRecommendation`.
- Response mapping:
  - CrystalOS 200 → mapped straight through to the client unchanged (route
    trusts CrystalOS's response already matches `ParseWorkflowNLSuccess`, since
    the registry it validated against is authoritative).
  - CrystalOS 422 (assumed shape: `{ message, suggestions }`, unconfirmed —
    see §0) → `agentsClient.parseWorkflowNL` throws a new
    `UnparseableWorkflowError(message, suggestions)`; the route catches this
    specifically and returns `422 { error: 'unparseable', message,
    suggestions }`, matching `toParseWorkflowNLError`'s expected shape in
    `app/src/lib/api.ts` exactly.
  - Timeout (agentsClient's `AbortController` firing, or any error whose
    message matches `/abort|timeout/i`) → `504 { error: 'Agents service timed
    out' }`.
  - Anything else → `serverError()` (generic 500, no internal details leaked),
    matching every other route in this file.

### 1.3 What must be re-verified once Amara's CrystalOS route exists

1. **Path.** `PARSE_WORKFLOW_NL_PATH` — confirm it's actually
   `/workflows/parse-nl` under `AGENTS_URL` and not, e.g., nested under a skill
   namespace like `/skills/workflow-nl-parse` or `/crystal/parse-workflow`.
   One-line fix in `agentsClient.ts` if wrong.
2. **422 body shape.** I assumed CrystalOS's unparseable response is
   `{ message: string, suggestions: string[] }` inside the same envelope
   `_fetch`'s error path stringifies (`Agents service error 422: <body>`).
   `agentsClient.parseWorkflowNL` defensively `JSON.parse`s that body and falls
   back to a generic message if it isn't JSON or doesn't match — so a mismatch
   here degrades to a correct-but-generic 422 rather than a crash, but the
   `suggestions` array (which the frontend's low-confidence/error UI renders)
   would be silently empty. **Verify this against Amara's real 422 body.**
3. **200 body field names.** I assumed CrystalOS's success response uses the
   same camelCase field names as the frontend contract (`triggerType`, not
   `trigger_type`) since the route passes it straight through with no
   transformation. **If CrystalOS emits snake_case** (which would match this
   codebase's Python/FastAPI convention elsewhere, e.g. `org_id`,
   `survey_id`), the route needs a translation layer before this ships — right
   now it does not have one. This is the single highest-risk mismatch to check
   first.
4. **Confidence threshold enforcement.** The route does not itself enforce the
   `confidence >= 0.6` threshold that routes to confirm-card vs. low-confidence
   UI (BUILDER_SPEC_WAVE2.md §2.4b) — that logic lives entirely in the
   frontend today. Confirm this is still the intended split (CrystalOS reports
   a raw confidence; the frontend decides the UI branch) rather than CrystalOS
   itself deciding to return a 422-shaped "low confidence" response below some
   threshold it owns.

---

## 2. Seam 2 — `workflow_signal` (CrystalOS → Backend, inbound)

### 2.1 Contract

```
POST /api/internal/workflows/signal
Auth: X-Internal-Key (requireInternalKey — service-to-service, NOT Clerk)
Request:
{
  org_id: string,                                       // required
  signal_type: 'sentiment_spike' | 'new_theme_detected' | 'anomaly_detected',  // required
  confidence: number,                                    // required, 0–1
  payload?: Record<string, unknown>,                     // default {}
  survey_id?: string,
  detected_at?: string,                                  // ISO 8601; defaults to receipt time if absent
  source_run_id?: string,                                // e.g. the insight pipeline run that emitted this
}
Response 202: { accepted: true, published: boolean }     // published:false only if Redis is down (best-effort)
Response 400: { error: string, errors: string[] }         // malformed signal (Zod validation)
Response 401: { error: 'invalid_internal_key' }
```

### 2.2 Why this shape

- **`org_id` travels explicitly in the body**, unlike every Clerk-authenticated
  route in this codebase where `req.orgId` comes from the session. There is no
  end-user session on a service-to-service call, so the caller (CrystalOS)
  must state which org the signal belongs to. This mirrors
  `routes/internal-metering.ts`'s existing precedent exactly (`org_id` in the
  body, not derived from auth).
- **`signal_type` is a closed enum of the three names TEAM.md and the TRACKER
  already commit to** (`sentiment_spike`, `new_theme_detected`,
  `anomaly_detected`) — not a free-form string — so a typo or drift on
  CrystalOS's side fails loudly (400) instead of silently publishing a trigger
  type nothing listens for.
- **`confidence` is required, not optional`,** for the same reason
  BUILDER_SPEC_WAVE2.md §2.1 requires it on the NL-parse response: "Crystal
  proposes, the app executes" means every AI-originated signal must carry a
  legible confidence value, never an implicit assumption of certainty. It's
  used here to derive `event.severity` (`>= 0.85` → `high`, `0.6–0.84` →
  `medium`, `< 0.6` → `low`) so downstream condition rules (`severity` is
  already a `CONDITION_FIELDS` entry in `workflowRegistry.ts`) can threshold on
  it without CrystalOS needing to know about Xperiq's severity vocabulary.
- **Routes into `publishWorkflowTrigger` (the async Redis Streams queue), not
  `runWorkflowsForEvent` (synchronous).** This was a deliberate choice between
  the two "which trigger machinery" options named in the brief. Rationale:
  `workflowQueue.ts`'s own header comment already documents exactly this
  problem for the Event Engine's original inline-call design — "a slow/failing
  workflow... could delay notification ACKs for unrelated events" — and this
  seam has the identical shape, just with CrystalOS as the caller instead of
  `eventEngine/processor.ts`. If CrystalOS calls this endpoint and a workflow
  it fires has a slow webhook action, that must never hang or fail CrystalOS's
  HTTP request; it should get an immediate 202 once the event is durably
  queued. Synchronous `runWorkflowsForEvent` would tie CrystalOS's request
  lifetime to Xperiq's action execution, which is the exact coupling the async
  queue exists to avoid elsewhere in this codebase.
- **`published: false` (not a 5xx) when Redis is down.** `publishWorkflowTrigger`
  already returns `null` in that case (best-effort, matching its existing
  contract for the Event Engine's use). Surfacing this as `202
  {accepted:true, published:false}` rather than a 500 tells CrystalOS "your
  signal was received and validated, but Xperiq's queue could not durably
  accept it right now" — accurate and actionable (CrystalOS could choose to
  retry), without making a Redis blip look like malformed input on CrystalOS's
  side.
- **Registry mapping is 1:1 today, not a rename/alias.** `crystal.anomaly_detected`
  already existed in `workflowRegistry.ts`'s `TRIGGERS`; this wave adds
  `crystal.sentiment_spike` and `crystal.new_theme_detected` as two net-new
  entries (see §3 below), resolving the naming-reconciliation question Rohan
  raised in `BUILDER_SPEC_WAVE2.md` §3, item 2: **all three signal types are
  independent, not a fourth signal aliasing an existing one.**

### 2.3 What must be re-verified once Amara's CrystalOS code exists

1. **Does CrystalOS actually call this path?** `/api/internal/workflows/signal`
   is a name I chose to match `/api/internal/metering/*`'s existing
   convention — it is not confirmed against any CrystalOS-side caller code,
   because none exists yet (see §0).
2. **Field names/casing.** I used snake_case (`org_id`, `signal_type`,
   `survey_id`, `detected_at`, `source_run_id`) to match this endpoint's sibling
   `/api/internal/metering/*` (which uses `org_id`, `action`, `ref`) rather than
   the camelCase used by `agentsClient.ts`'s *outbound* calls — outbound calls
   to CrystalOS in this codebase already mix conventions (e.g.
   `triggerManualInsightRun` sends `survey_id`/`org_id` snake_case in its
   `_fetch` body despite camelCase JS param names), so snake_case for a
   CrystalOS-originated inbound payload is the more consistent choice, but
   **confirm against Amara's actual emitted payload**, not this assumption.
3. **Does the insight pipeline emit one signal per detection, or a batch?**
   This endpoint accepts exactly one signal per call. If Amara's pipeline
   design batches multiple signals per run (e.g. one HTTP call per pipeline
   run listing N detected themes), this endpoint needs either a `signals: []`
   array variant or CrystalOS needs to call it N times. Not designed around
   this because nothing in TEAM.md/TRACKER specifies pipeline emission
   cadence — flagging for the AI Trigger Sync (Thursday, per TEAM.md's team
   rituals) once Amara's design is concrete.
4. **`detected_at` semantics** — I default it to receipt time if CrystalOS
   omits it. Confirm whether the pipeline actually has a more precise
   detection timestamp worth always sending (likely yes, given `agent_runs`
   already tracks `heartbeat_at` and similar timestamps elsewhere in this
   codebase) — if so this should become required, not optional, before GA.

---

## 3. Registry gap fix (this wave)

`workflowRegistry.ts`'s `TRIGGERS` was missing `sentiment_spike` and
`new_theme_detected` — flagged by Rohan (`BUILDER_SPEC_WAVE2.md` §3, item 2)
and independently by Amara's TEAM.md mandate (the three AI trigger names).
Added both, following the existing `{ type: 'crystal.X', category: 'Crystal',
label }` shape:

```ts
{ type: 'crystal.sentiment_spike',    category: 'Crystal', label: 'Sentiment spike detected' },
{ type: 'crystal.new_theme_detected', category: 'Crystal', label: 'New theme detected' },
```

`crystal.anomaly_detected` is unchanged — confirmed (per §2.2 above) to be a
distinct, third signal, not an alias needing a rename.

---

## 4. Files changed (backend side)

- `backend/src/lib/agentsClient.ts` — `parseWorkflowNL()`,
  `UnparseableWorkflowError`, `PARSE_WORKFLOW_NL_PATH` const.
- `backend/src/schemas/workflows.ts` — `parseWorkflowNLSchema`,
  `workflowSignalSchema`.
- `backend/src/routes/workflows.ts` — `POST /parse-nl`.
- `backend/src/routes/internal-workflows.ts` (new) — `POST
  /api/internal/workflows/signal`.
- `backend/src/index.ts` — mounts `internal-workflows` router at
  `/api/internal/workflows` (service-to-service, no `apiLimiter`, matching the
  `/api/internal/metering` precedent).
- `backend/src/lib/workflowRegistry.ts` — two new `TRIGGERS` entries.
- Tests: `workflowsParseNl.test.js` (8 tests), `internalWorkflowsSignal.test.js`
  (10 tests), `workflowRegistry.test.js` (4 tests), plus
  `workflowsRoutesPermissions.test.js` updated to cover the new `/parse-nl`
  route in its permission matrix and mock `agentsClient`.

No new env vars were introduced — both seams reuse the existing `AGENTS_URL`/
`AGENTS_INTERNAL_KEY` pair already documented in `docs/ENV_VARS.md`.

---

## 5. Sign-off (Nina Reeves, Phase 3 seam integration owner)

**Per TEAM.md: "Act as integration owner for Phase 3 (AI triggers) — sign off
before CrystalOS → backend seam ships."**

**Verdict: Backend side APPROVED for its own correctness and consistency with
existing patterns. The seam as a whole is NOT YET production-ready** — it
cannot be, because the CrystalOS side does not exist yet to reconcile against
(see §0). This is not a rejection of Amara's work; there is no work to review.
It is a statement that the "seam" only has one leg built.

**What I verified on the backend side:**
- `POST /api/workflows/parse-nl` uses the exact `requireAuth` +
  `requirePermission('workflows:manage')` gate every other route in
  `routes/workflows.ts` uses — no gap introduced.
- Request validation (1–1000 char `description`) matches the frontend's
  already-built contract exactly (`app/src/lib/api.ts` sends raw
  `{ description }`, nothing else).
- Error mapping (422/504/500) produces exactly the shape
  `toParseWorkflowNLError` in `app/src/lib/api.ts` already parses — verified by
  reading that function directly, not assumed from the spec doc alone.
- `POST /api/internal/workflows/signal` follows the established
  service-to-service precedent (`requireInternalKey`, no Clerk, no
  `apiLimiter`) to the letter — same middleware, same mount-comment style, same
  "org_id explicit in body" convention as `routes/internal-metering.ts`.
- Routing choice (async queue over sync engine call) is justified by this
  codebase's own existing rationale for the same problem shape
  (`workflowQueue.ts`'s header comment), not invented fresh.
- The registry gap fix is additive only — `crystal.anomaly_detected` untouched,
  no existing workflow definitions could reference a trigger type that changed
  meaning.
- Full backend suite green: **75 files / 911 tests passing** (baseline going in
  was 72 files / 889 tests; +3 files / +22 tests from this wave — 8 parse-nl +
  10 signal-receiver + 4 registry, no regressions). `tsc --noEmit` shows zero
  new errors (the six pre-existing errors in `lib/prism/uploads.ts` predate
  this wave, confirmed via `git log`, unrelated to workflows).

**Required before this seam is truly production-ready (blocking, not
optional):**
1. Amara's CrystalOS-side `parse-nl` route and `workflow_signal` emitter must
   actually exist and be reconciled against §1.3 and §2.3 above — in
   particular the **200/422 field casing** (§1.3.3) and **the actual endpoint
   path** (§1.3.1) are the highest-risk mismatches; a silent casing mismatch
   would make every NL-parse response fail frontend rendering without ever
   returning a non-200 status, which existing tests here cannot catch since
   they mock `agentsClient` at the boundary.
2. Once Amara's code exists, re-run this reconciliation pass and update this
   document's §0 status line and the "must be re-verified" subsections into
   confirmed facts (or corrected contract) before flipping this sign-off from
   "backend approved, seam incomplete" to "seam approved end-to-end."
3. An integration test that exercises both sides together (even a local
   docker-compose run hitting a real CrystalOS dev server) should happen at
   least once before this reaches production traffic — everything in this
   wave's test suite mocks the CrystalOS boundary by necessity (no CrystalOS
   code to call), which is correct for unit coverage but is not a substitute
   for one real end-to-end call.

**Escalation:** per TEAM.md's Decision Framework, "Any change to the
`workflow_signal` contract between CrystalOS and backend" requires Priya +
Nina sign-off. This document is Nina's half; once Amara's implementation
exists, loop in Priya if the reconciliation in §1.3/§2.3 surfaces anything
that changes the queue/idempotency shape (e.g. batched signals per §2.3 item 3
would touch `workflowQueue.ts`, which is Priya's file).

---

## 6. Amara's reconciliation pass (CrystalOS side, Wave 3)

I read this document in full before writing any CrystalOS code, per the brief.
Going through §1.3 and §2.3 in order, against what I actually built:

### 6.1 Seam 1 (`POST /workflows/parse-nl`) — reconciled against §1.3

1. **Path — CONFIRMED.** `crystalos/main.py` mounts exactly
   `POST /workflows/parse-nl` (not nested under a skill namespace). Your
   `PARSE_WORKFLOW_NL_PATH = '/workflows/parse-nl'` constant is correct as-is
   — no change needed on your side.
2. **422 body shape — WAS GOING TO BE WRONG, FIXED BEFORE YOU'D HAVE HIT IT.**
   You correctly flagged this as highest-risk. My first draft used
   `raise HTTPException(status_code=422, detail={...})`, which FastAPI wraps
   as `{"detail": {...}}` on the wire — your `_fetch`'s raw body text would
   have been `Agents service error 422: {"detail":{"error":...}}`, and your
   `JSON.parse(raw)` would have produced `{detail: {...}}` with `.message`/
   `.suggestions` both `undefined` at the top level, exactly the failure mode
   you predicted. Caught this myself while re-reading FastAPI's own wrapping
   behavior before finalizing — the endpoint now returns
   `JSONResponse(status_code=422, content={"error": "unparseable", "message":
   str, "suggestions": [str, ...]})` directly (not `HTTPException`), so the
   body is flat at the top level. **`message` and `suggestions` are both
   present at the top level exactly as your parser expects — no change needed
   in `agentsClient.ts`.**
3. **200 body field names — CONFIRMED camelCase, not snake_case.** The success
   response is built as a plain dict literal in the endpoint (not returned via
   a Pydantic model with an alias generator), explicitly using `triggerType`,
   `name`, `description`, `nodes`, `edges`, `confidence`, `warnings` — I
   deliberately did not default to this service's usual Python snake_case
   convention here specifically because this response is a pass-through
   contract with the frontend's `ParseWorkflowNLResult` (camelCase), and your
   route forwards it unchanged. **No translation layer needed on your side —
   your assumption was correct.**
4. **Confidence threshold enforcement — CONFIRMED, split as you assumed.**
   CrystalOS returns 200 with a raw `confidence` for anything at or above
   `UNPARSEABLE_THRESHOLD = 0.25` (see `crystal/workflow_nl.py`) — it does NOT
   itself apply the `0.6` confirm-card/low-confidence split; that stays a
   frontend concern exactly as BUILDER_SPEC_WAVE2.md §2.4b specifies and your
   route already assumes. CrystalOS's own 422 is reserved for the genuinely
   unusable case (below 0.25, or no valid trigger/action survived registry
   validation) — a materially different, lower bar than the UI's 0.6
   confirm-card cutoff.

### 6.2 Seam 2 (`workflow_signal`) — reconciled against §2.3

1. **Does CrystalOS call this path? YES, exactly as specified.**
   `crystalos/lib/workflow_signal_client.py::emit_workflow_signal()` POSTs to
   `{BACKEND_INTERNAL_URL}/api/internal/workflows/signal` with `X-Internal-Key:
   AGENTS_INTERNAL_KEY` — same shared secret, reused in the reverse direction
   from its usual Node→CrystalOS flow. **New env var required:**
   `BACKEND_INTERNAL_URL` (default `http://localhost:3001`), added to root
   `.env.example` and `docs/ENV_VARS.md` in this same change — there was no
   existing "CrystalOS calls Node" base URL to reuse (`AGENTS_URL` is the
   opposite direction; `PUBLIC_API_URL` is specifically for externally-facing
   OAuth redirects, a different semantic).
2. **Field names/casing — CONFIRMED snake_case, matches your assumption
   exactly.** The emitted body is `{org_id, signal_type, confidence, payload,
   survey_id, detected_at, source_run_id}` — same keys, same casing as
   `workflowSignalSchema`. No translation needed.
3. **Batch vs. one-call-per-signal — ONE CALL PER SIGNAL, not batched.** The
   insight pipeline's new `node_ai_triggers` node (runs once per automated
   run, after `publish`) can detect zero, one, or multiple signals in a single
   run (e.g. a run could simultaneously have a sentiment spike AND a new
   negative theme) — in that case it calls `emit_workflow_signal()` once per
   fired signal, sequentially, not as a batched array. This keeps
   `/api/internal/workflows/signal`'s existing single-signal contract
   unchanged — no `signals: []` variant needed, and no change to
   `workflowQueue.ts`'s idempotency shape, so this does **not** need to loop
   in Priya per the doc's own escalation note.
4. **`detected_at` semantics — ALWAYS SENT, not omitted.** CrystalOS sets
   `detected_at` to the pipeline's own completion timestamp (same
   `time.strftime(...)` pattern already used for `report_blob["generated_at"]`
   elsewhere in `graphs/insights.py`) on every call — it is never left for the
   backend's receipt-time default in practice. Recommend flipping it to
   required in `workflowSignalSchema` now that a real, always-populated caller
   exists — flagging for Nina/backend as a small follow-up (out of my file
   scope this wave), not blocking.

### 6.3 What Nina should re-verify (small, explicit list)

Everything above was verified by reading the actual CrystalOS code, not
inferred. The one item that's a genuine judgment call worth a second set of
eyes, not just a fact-check:

- **AI trigger thresholds/hysteresis are new and unvalidated against real
  data** (see `crystalos/lib/ai_triggers.py`'s module docstring for the full
  threshold table + rationale). These are conservative-by-design defaults, not
  tuned against production firing rates — TEAM.md's own "AI Trigger Sync"
  ritual (Thursdays, Amara owns) exists specifically to revisit these once
  real signals start firing. Nothing here changes the wire contract Nina
  owns, so it doesn't block sign-off, but it's the part of this wave with the
  least empirical grounding.

**Reconciliation verdict: seam confirmed end-to-end on paper (both sides read
each other's actual code, not assumptions) — real end-to-end integration test
against a live pair of services (Nina's §5 item 3) is still outstanding, as
expected, since it requires a running Postgres + Redis + both services.**
