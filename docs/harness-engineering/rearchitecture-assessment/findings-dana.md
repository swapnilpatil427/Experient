# Findings — Dana (Xperiq Backend Expert)

## 1. Vantage-point summary

I read the assignment brief, the team roster, and `Crystal-harness/00-SYNTHESIS.md` in
full, then grounded the assessment in the actual Express↔CrystalOS wire contract as it
exists in code today (not as documented, where the two disagree):

- `backend/CLAUDE.md`, `crystalos/CLAUDE.md`
- `backend/src/lib/agentsClient.ts` (the single typed outbound client — ~30 exported
  functions, one per CrystalOS route)
- `backend/src/routes/admin.ts` (the second outbound path — a raw proxy)
- `backend/src/routes/insights.ts` — specifically `POST /:surveyId/generate`,
  `POST /:surveyId/topics/backfill`, `POST /:surveyId/crystal` (non-streaming),
  `GET/DELETE /:surveyId/crystal/history`, `POST/GET /:surveyId/crystal/proposals`
- `backend/src/routes/experience.ts` — `crystalHandler` (`/crystal`, `/org/crystal`) and
  `POST /:scope/crystal/stream` (the real SSE proxy)
- `backend/src/routes/alerts.ts` (`POST /` — action-proposal execution target for
  `create_alert`) and `backend/src/routes/workflows.ts` (`POST /` — execution target for
  `create_workflow`)
- `crystalos/main.py` lines ~1590-1830 — `POST /insights/crystal` (single-shot),
  `POST /insights/crystal/stream` (SSE), `POST /insights/crystal-support`

I did **not** re-read CrystalOS's internals beyond what's needed to characterize the
wire shape (that's Marcus's job); I did **not** propose any code change (research-only
task).

**Headline finding: the backend contract is almost entirely insulated from internal
CrystalOS rearchitecture — with one specific, named exception.** None of the Tier-1
harness patterns (fail-fast identity gate, provenance stamping, tool-error contract,
verbose-output routing, negative-example audits, "when can this be removed" table) touch
the wire at all — they are 100% internal to CrystalOS's process. Of the Tier-2 patterns,
only the `applied_filters`-equivalent (item 7) is a response-shape change, and it's
additive/optional, not breaking. Everything else in Tier 2/3 (validator-script pattern,
offline eval harness, named hook vocabulary, structured memory) is internal. Details
below.

## 2. Simplification opportunities

These aren't harness-pattern-driven; they're things I noticed while reading the actual
call sites that a `RequestValidationMiddleware`-equivalent (Tier 1 #1) would incidentally
clean up on the **backend** side too, since the backend currently duplicates some of
what such a gate would centralize:

- **`_agentsFetch` in `backend/src/routes/insights.ts` (lines 60-83) duplicates
  `agentsClient.ts`'s `_fetch`** (lines 38-61) almost line-for-line — same
  AbortController/timeout/`X-Internal-Key`-injection/error-wrapping logic, just a second,
  parallel implementation local to one route file instead of importing `agentsClient`'s
  helper (which isn't exported). `routes/insights.ts` even imports `agentsClient` for
  some calls (`agentsClient.triggerTopicBackfill`) but hand-rolls `_agentsFetch` for others
  (`/insights/generate`, `/insights/crystal`). This is a pre-existing Express-side
  inconsistency, not something CrystalOS rearchitecting would fix — but if the team ever
  does touch this seam, consolidating to one fetch helper (exported from
  `agentsClient.ts`) removes a maintenance seam where the two timeout/error-handling
  implementations could silently drift.
- **Three independent SSE/JSON pluck-sites for the same CrystalOS response shape**:
  `routes/insights.ts`'s `/:surveyId/crystal` (reads `response.answer/suggestions/
  insight_refs/citations/viz`), `routes/experience.ts`'s `crystalHandler` (its own
  buffered `data:`-line parser that plucks `ev.answer/suggestions/citations/viz` from the
  SSE stream, then falls back to a second plain-JSON fetch with the same pluck), and
  `routes/experience.ts`'s `/:scope/crystal/stream` (a byte-transparent proxy that does
  **not** pluck fields — it forwards raw chunks). Only the first two are field-allowlists;
  a shared response-shape type (even just a TS interface CrystalOS's OpenAPI/Pydantic
  schema could generate) would make it mechanically obvious which fields are forwarded
  vs. silently dropped. Not a harness pattern per se, but the "schema-generation-on-demand
  from Pydantic models instead of hand-maintained schema docs" idea (BRIEF.md's "Take"
  list) would help exactly this seam if CrystalOS ever exposes a typed response schema
  the backend could import/generate against.

## 3. Improvement opportunities (tied to synthesis doc patterns)

- **Tier 1 #3 (formalize the tool-error contract, `03` §3.5)** — this is CrystalOS-internal
  (`dispatch_tool` → `{"error": ...}` dicts, never raised) and has **zero** backend-visible
  effect *except* one thing worth naming: today, when CrystalOS itself 5xxs or times out,
  the backend's own error-handling is inconsistent across call sites — `agentsClient.ts`'s
  `_fetch` throws a typed `AgentsError` with `.status`, but `_agentsFetch` in
  `routes/insights.ts` throws a bare `Error` with a status property bolted on via
  `Object.assign` (same shape, different constructor). If CrystalOS formalizes "every tool
  error is a structured dict" as an internal convention, that's invisible to Express
  either way — Express only ever sees the *HTTP*-level success/failure of a whole request,
  never an individual tool's error dict (that's consumed and folded into the LLM context
  entirely inside CrystalOS). **No backend change needed or beneficial here.**
- **Tier 1 #2 (provenance stamping, `02` `_provenance.py`)** — purely internal (adds
  `crystalos_version` to CrystalOS's own trace/log lines via `importlib.metadata.version`).
  Zero backend contract impact. If the team ever wants this queryable from the Node side
  (e.g. surfaced in the admin UI via `/api/admin` proxy), that's an *additive* new field on
  whatever JSON `/api/admin/*` already proxies through unmodified — the proxy in
  `routes/admin.ts` is a byte-for-byte passthrough (`res.send(body)` on the raw upstream
  text), so a new field appears automatically with zero Express-side code change. This is
  the cleanest possible "leak point" if the team wants it visible later: no contract
  change required even to expose it.
- **Tier 2 #7 (`applied_filters`-equivalent, `03` `AppliedFiltersMiddleware`)** — **this is
  the one pattern that would touch the wire.** It's a new field on:
  - `POST /insights/crystal`'s response dict (main.py line ~1605) — currently a fixed
    5-key dict (`answer, suggestions, insight_refs, citations, viz` + `turn_id`); adding
    `applied_filters` is additive to that dict.
  - `POST /insights/crystal/stream`'s SSE `type: "answer"` event (main.py line 1817 and
    the `_run_skill_stream`/`_run_react_loop_streaming` generators) — additive to that
    event's JSON.
  Both changes are backward-compatible **on the wire** (old Express code ignores unknown
  JSON keys), but — and this is the concrete gap — `routes/experience.ts`'s `crystalHandler`
  (the internal SSE consumer used by `/crystal` and `/org/crystal`) explicitly **allowlists**
  which SSE keys it forwards to its own JSON response (`ev.answer`, `.suggestions`,
  `.citations`, `.viz` only — see the `viz` field's own comment at line ~541-545 noting it
  was deliberately added as "neutral passthrough... don't let the allowlist below silently
  drop it like it does every other unlisted SSE key"). **`applied_filters` would silently
  vanish at this exact chokepoint unless `crystalHandler` is explicitly updated to pluck
  it, the same way `viz` needed its own explicit addition.** The raw SSE proxy
  (`/:scope/crystal/stream`) needs no change — it forwards bytes untouched, so
  `applied_filters` reaches the frontend automatically via that path. **Action for
  whoever picks up Tier 2 #7: update `crystalHandler`'s pluck list in
  `backend/src/routes/experience.ts` (both the streaming-fetch branch and the
  direct-fetch fallback branch) in the same PR that adds the field on the CrystalOS side.**
- **Tier 2 #10 (named hook-point vocabulary in `SkillRuntime.execute()`, `01`+`03`)** —
  purely internal control flow inside `skill_runtime.py`/`crystal.py`. As long as the
  final yielded/returned shape at the two HTTP boundaries above is unchanged, Express
  cannot observe *how* CrystalOS got there. **Zero backend impact**, contingent only on
  the hook points not becoming a vehicle for emitting new response fields — if they are
  (e.g. a PII-redaction hook that adds a `redactions_applied` field), that's the same
  category of change as `applied_filters` above and needs the same explicit-pluck-list
  update.
- **Tier 2 #8 (validator-script-paired-eval-gate)** and **Tier 2 #9 (offline eval
  harness)** — both fully internal to CrystalOS's skill-authoring/testing loop. No wire
  impact; not backend-observable at all, even indirectly (they change *how confidently*
  CrystalOS answers, not the shape of what it returns).
- **Tier 3 #11 (structured memory over prompt-accumulated context)** — if ever pursued,
  this replaces `crystal_threads`' JSONB blob-of-messages model. That table is currently
  **owned and read directly by Express** (`routes/insights.ts`'s `/:surveyId/crystal`
  handler does its own `SELECT/INSERT ... crystal_threads` — CrystalOS never touches this
  table in the non-streaming path I read). Any move to "structured, addressable fact
  storage" would need to either (a) stay Express-owned exactly as today, or (b) if moved
  into CrystalOS's own storage, would require a **new contract**: today Express reads
  conversation history itself and threads it into `conversation_history` in the request
  body — CrystalOS never fetches its own history. This is worth flagging even though it's
  Tier 3/deferred: it's the one place in the whole assessment where "backend already owns
  this state" is a structural fact a future redesign could easily get backwards.

## 4. Risks / what could break

Backend-integration-safety specific, assuming the external contract is nominally
preserved:

1. **The SSE framing assumption in `crystalHandler`'s manual parser is load-bearing and
   fragile.** `routes/experience.ts`'s `crystalHandler` (lines ~526-548) does its own
   buffered read of `streamRes.body`, splitting on `\n` and matching lines starting with
   `data: `, treating `[DONE]` as a sentinel. This is a hand-rolled SSE parser, not a
   library — it silently assumes CrystalOS always emits exactly one `data: {...}` line per
   event, terminated by `\n\n`, with no multi-line `data:` continuations (which the SSE
   spec technically allows). Nothing in a harness-style internal refactor targets this,
   but if any internal restructuring (e.g. streaming individual tool-call deltas, or a new
   hook emitting partial-JSON chunks) changes how `_run_skill_stream` yields event strings,
   this parser could silently misparse without CrystalOS's own tests ever catching it
   (they don't exercise the Express-side consumer). **This is the single highest-risk
   "invisible-on-paper, real-in-practice" coupling I found.** The byte-transparent proxy
   (`/:scope/crystal/stream`) doesn't have this problem — it never re-parses.
2. **Two different Crystal entry points exist in Express with different fetched paths and
   different result shapes, and `backend/CLAUDE.md`'s own docs undersell this.**
   `backend/CLAUDE.md` line 65 describes `POST /api/insights/:surveyId/crystal` as "Crystal
   SSE stream (proxied to CrystalOS skill-first path)" — but the actual code
   (`routes/insights.ts` lines 1288-1489) calls CrystalOS's **non-streaming**
   `POST /insights/crystal` (a single JSON fetch via `_agentsFetch`, no SSE at all,
   90s timeout). The real SSE proxy lives in `routes/experience.ts`'s
   `POST /:scope/crystal/stream`. This is a pre-existing doc/reality drift, not something
   this assessment caused — but it matters here because any assumption "the backend
   already has a single well-understood Crystal call site" is wrong; there are at least
   three (non-stream single-shot in `insights.ts`, SSE-consumed-then-JSON-returned in
   `experience.ts`'s `crystalHandler`, and true SSE passthrough in
   `experience.ts`'s `/:scope/crystal/stream`), each with different timeout values,
   different response-shape assumptions, and different resilience to a CrystalOS-side
   response-shape change. A harness rearchitecture team should not assume "the contract"
   is one thing to preserve — it's three, independently.
3. **The single-shot `/insights/crystal` endpoint never returns `action_proposals`** (see
   `main.py` line ~1605-1612) — only the SSE path (`_run_skill_stream`) and
   `/insights/crystal-support` do. If a harness-style internal refactor consolidates
   response construction across these three endpoints (a natural simplification), it must
   preserve this asymmetry deliberately or the non-streaming path would start emitting
   proposals that no Express caller currently expects/handles for that specific call site
   — not a breaking risk per se (extra JSON keys are ignored), but a functionality
   assumption worth flagging as a "must decide, not accidentally change" item.
4. **`AGENTS_INTERNAL_KEY` has three independent literal-default fallbacks in Express**
   (`agentsClient.ts`, `routes/insights.ts`, `routes/experience.ts` each re-declare the
   same `?? (process.env.NODE_ENV !== 'production' ? 'dev-internal-key-change-in-prod' :
   throw)` expression). This is not a CrystalOS-rearchitecting risk, but it means the
   "identity validation" story on the Express side is already itself non-DRY — three
   copies of the same fallback logic that could drift if only one is edited during a
   future change.
5. **Fire-and-forget credit debiting after a successful CrystalOS call is a timing
   assumption, not a contract assumption.** Several routes (`/:surveyId/generate`,
   `crystalHandler`, `/:scope/crystal/stream`) debit credits *after* CrystalOS accepts/
   responds, treating "CrystalOS accepted the call" as "spend happened." An internal
   CrystalOS refactor that changes *when* work actually starts relative to the HTTP
   response (e.g., making the currently-synchronous `POST /insights/runs`/
   `POST /reports/custom/run` background-task kickoff pattern truly async before doing any
   real work) wouldn't change the JSON contract, but could change the economic assumption
   embedded in Express's debit timing. Worth a regression test asserting debit only fires
   after a genuine `2xx`, which today's code already does — but this is exactly the kind
   of "not in the contract on paper" behavior that's easy to invalidate with an
   internals-only change.

## 5. Assessment of `X-Internal-Key`/`AGENTS_INTERNAL_KEY` vs. QAH's fail-fast identity
   validation pattern

**There is a real, if narrow, gap.** QAH's `RequestValidationMiddleware` pattern (per
`03` §3.7, and Tier 1 item #1 in the synthesis) is specifically about validating
**identity/context** (org_id, user_id, survey_id, permissions) as the very first thing
that runs, before any tool call or LLM work — i.e., request-*shape* validation, not just
transport-*auth*.

What Express's calling pattern already does well: **every single outbound call
(`agentsClient.ts`, the two `_agentsFetch`-style helpers, and `admin.ts`'s proxy) injects
`X-Internal-Key` uniformly** — there is no call site that forgets it, because it's baked
into the shared header-construction helper in each file. This is good, uniform
*transport*-level fail-fast: CrystalOS's `require_internal_key` dependency (per
`crystalos/CLAUDE.md`) rejects a request with a missing/wrong key immediately, before any
handler code runs — that part of the fail-fast story is solid and already matches the
QAH pattern in spirit.

**What's missing is validation of the request's *content* shape** (`org_id`/`survey_id`
actually present and non-empty, `user_id` actually resolved) **before** it's forwarded.
Concretely:
- `routes/experience.ts`'s `crystalHandler` builds `agentBody` with `org_id: orgId,
  user_id: userId, survey_id: (survey_id as string) || ''` — if `survey_id` is
  `undefined`/missing on a request that should have it, it's silently coerced to `''` and
  forwarded to CrystalOS as an empty string rather than rejected at the Express boundary.
  CrystalOS's own `check_survey_access` (called conditionally `if survey_id:`) will simply
  skip the access check for an empty string, treating it as "no survey scope" rather than
  "malformed request" — the request doesn't fail-fast, it silently reinterprets scope.
- `routes/insights.ts`'s `/:surveyId/crystal` **does** call `getSurvey(surveyId, req.orgId)`
  and 404s if the survey isn't found/owned — this is a real, present fail-fast gate, but
  it exists only in this one route, not as a shared middleware every Crystal-facing route
  goes through. `crystalHandler`'s org-scope branch has no equivalent existence check
  before forwarding (there's nothing to check — org scope has no survey_id — but the
  broader point stands: each route independently decides its own validation depth).
- The `tag_id` handling in `loadCrystalContext` is actually the **strongest** existing
  example of the QAH pattern already implemented ad hoc: it explicitly re-validates
  `tag_id` belongs to `orgId` via a scoped query before trusting it, and falls through to
  a safe default rather than forwarding an unvalidated cross-org id — this is exactly
  "fail-fast/fail-safe on identity before forwarding," just implemented per-field, per-route,
  not as one named, tested, reusable gate.

**Net assessment**: CrystalOS *can* receive a request with a missing/empty `survey_id` or
`org_id` that Express didn't reject — it won't crash (Python's conditionals guard against
`None`/falsy), but it will silently answer with a different, unintended scope (e.g.
org-wide instead of survey-scoped) rather than failing loudly with a clear error. This
matches the brief's framing exactly: "fail late/confusingly" is the actual failure mode
today, not a hard crash. **A single shared Express-side validation gate — one function
all Crystal-facing routes call before constructing `agentBody`, asserting
`orgId` is present (already guaranteed by `requireAuth`) and, when the route implies a
survey/tag scope, that the referenced entity exists and belongs to this org — would close
this gap without requiring any CrystalOS-side change.** This is a backend-side
improvement opportunity independent of anything happening inside CrystalOS; it's listed
here because the assignment specifically asked me to assess it against QAH's pattern.

## 6. Your recommendation

**Adopt selected patterns only — no rearchitecture, and no CrystalOS-driven urgency from
the backend-integration-safety angle.** From this vantage point, the wire contract is
almost entirely insulated from CrystalOS's internal shape: every Tier 1 pattern and most
of Tier 2/3 are invisible to Express by construction (they change *how* CrystalOS decides
what to say, not the JSON/SSE shape of what it says). The one pattern that does touch the
contract (`applied_filters`, Tier 2 #7) is a strictly additive field, safe on the wire,
with exactly one known Express-side chokepoint (`crystalHandler`'s SSE-key allowlist in
`routes/experience.ts`) that needs an explicit update in the same PR — a small, contained,
well-scoped piece of work, not a reason to gate or resequence any broader CrystalOS
refactor. The actual risk surface I found is not "will a harness pattern break the
contract" (it won't) but two pre-existing, contract-adjacent fragilities worth fixing
regardless of whether the harness rearchitecture proceeds: the hand-rolled SSE parser in
`crystalHandler` (item 4.1) and the missing shared identity/scope validation gate on the
Express side (item 5). Neither blocks CrystalOS from adopting any pattern in the synthesis
doc; both are backend-owned fixes that would make the *whole* system more fail-fast,
independent of this rearchitecture decision.

## 7. Open questions for the rest of the team

1. **Marcus/Priya**: if Tier 2 #7 (`applied_filters`) is pursued, can the design decision
   ("canonical filter-tree shape across CrystalOS's own data sources," per the synthesis)
   also fix the asymmetry I found in §3/§4.3 — that the non-streaming `/insights/crystal`
   endpoint never returns `action_proposals` at all? If both are being touched in the same
   response-shape work, it's a good place to also decide/document that asymmetry
   deliberately (or eliminate it) rather than let a third inconsistency compound.
2. **Jordan**: does the frontend's SSE consumption (via `CrystalPanel.tsx`, hitting
   `/:scope/crystal/stream`'s byte-transparent proxy) do its own `data:` line parsing that
   has the same fragility I flagged in `crystalHandler`'s server-side parser (item 4.1)? If
   so, that's a second, independent copy of the same "assumes exactly one `data:` line per
   SSE event" assumption, and worth naming as a shared regression-test target (one fixture
   generator both sides could test against) regardless of what CrystalOS's internals end
   up looking like.
3. **Reyes**: is there any appetite for a contract test (backend-owned, run in CI) that
   pins the exact JSON keys `POST /insights/crystal` and the SSE `type: "answer"` event are
   allowed to add/remove, so a future CrystalOS-side field addition/removal is caught at
   the boundary rather than discovered by a silently-dropped field in production? This
   would directly de-risk the one leak point named in §3.
4. **Priya**: if the named hook-point vocabulary (Tier 2 #10) is adopted, is there a
   convention being considered for how a hook signals "I added a new top-level response
   field" vs. "I only changed internal reasoning"? From the backend's perspective, that
   distinction is the entire ballgame for whether a given internal change needs an Express
   PR alongside it.
