# Plan — CrystalOS + Backend Contract

> **Author:** Priya Raghunathan, Principal Engineer (Agent Runtime)
> **Layer:** `crystalos/` + `backend/`
> **Mandate:** `TEAM.md` §3 · **Charter:** `README.md` (re-chartered 2026-08-04)
> **Date:** 2026-08-04
> **Status:** Executable plan. No production code written, no migrations run, no DB touched.
> **Supersedes:** the `PARTIAL` verdict in `ASSESSMENT_CRYSTALOS.md` §7. Facts from that document are carried forward and, where re-verified, corrected below.

---

## 0. What this document decides

The migration is decided. This plan covers everything CrystalOS and the Express bridge owe it, plus the contract debt that becomes a prerequisite on the way through.

| # | Workstream | Gate | Days | Blocking for frontend? |
|---|---|---|---|---|
| 1 | Message identity (`turn_id` / `message_id` on the wire) | **G1** (slice in G0) | 5.5 | **Yes** — `onEdit`/`onReload`/feedback/persistence all key on it |
| 2 | `generative-ui` emit contract — Tier 0 deterministic | **G0** | 2.0 | **Yes** — G0 acceptance requires one server-emitted chart |
| 2b | `generative-ui` — Tier 1 model-referenced | **G3** | 2.5 | No — additive |
| 3 | Proposals as server-minted, identified, tool-call-shaped objects | **G1** | 3.5 | **Yes** — decides whether Nadia writes a registry or a switch |
| 4 | Funnel repair + migration discontinuity | **G1** | 2.5 | No (but gates G2 exit with Sam) |
| 5 | `user_role` — staged, audit-gated | **G1** stage 1 / **G4** stage 3 | 1.5 | No |
| 6 | Thread persistence on `crystal_threads` v2 | **G3** | 4.5 | Partly — `RemoteThreadListAdapter` needs it |
| 7 | `locale` on `CrystalInput` | **G2** | 0.5 | No |
| 8 | Quick wins (latency, query params, i18n codes, OpenAPI test) | G0/G2 | 4.25 | One item does (`observation.summary`) |
| — | **Total CrystalOS + backend** | | **≈26.75 d** | |

Two prerequisites I did not previously identify are **hard blockers** and are called out in §2.3 and §12: the EVALS `non-empty` scorer makes any new optional output field fail a must-pass criterion, and the telemetry task scheduler raises a swallowed `TypeError` on every turn.

**Honest framing on cost.** My prior assessment costed ~14 days of contract work. This plan is ~27, because generative UI is new work (4.5 d), proposals grew a message-part shape (+0.5 d), `user_role` became a staged audit rather than a one-liner (+1 d), and thread persistence absorbed the `MemoryManager` and sweeper cleanup it was previously allowed to defer (+1.5 d). None of that is padding. Roughly 12 of the 27 days produce **no user-visible change on their own** — they are the price of the loop being measurable and the charts being trustworthy.

---

## 1. Message identity — gate G1 (slice in G0)

### 1.1 The defect, re-verified

`crystal_turn_events.id` is a `UUID PRIMARY KEY DEFAULT gen_random_uuid()` (`supabase/migrations/20260623000002_crystal_telemetry.sql:6`). It is minted by Postgres inside `_write_turn_event` (`crystalos/lib/turn_publisher.py:75-106`), scheduled fire-and-forget by `publish_turn_event` (`turn_publisher.py:112-121`), which `_fire_telemetry` calls at `crystalos/agents/crystal.py:1659`.

`_fire_telemetry` is invoked at `crystal.py:1975` and `crystal.py:1993` — in both cases **after** the terminal `answer` frame has already been yielded (`:1968-1974` skill path, `:1983-1989` fallback path). The id therefore does not exist at any point when we could put it on the wire, and nobody reads it back.

The ordering consequence is codified in the schema. `crystal_turn_events.thread_id` was `TEXT NOT NULL` (`20260623000002_crystal_telemetry.sql:11`); migration `20260623000009_crystal_turn_events_skill_name.sql:12-14` drops the `NOT NULL` with the comment *"GAP 7: Make thread_id nullable (fire_telemetry calls before thread is created)"*. The corresponding code site is `crystal.py:1645` — `thread_id=None,   # nullable after migration 009`. **We migrated the schema to match the bug.** Reversing the order is what lets us reverse the migration.

### 1.2 New finding — the telemetry task is scheduled incorrectly and the error is swallowed

`publish_turn_event` is a **synchronous** `def` returning `None` (`turn_publisher.py:112`). `crystal.py:1659` calls `asyncio.create_task(publish_turn_event(event, ctx))`. Evaluation order means the inner call runs first — correctly scheduling `_write_turn_event` — and then `asyncio.create_task(None)` raises `TypeError: a coroutine was expected`, caught by the bare `except Exception: pass` at `crystal.py:1660-1661`.

So telemetry works **by accident**, and every Crystal turn raises and discards a `TypeError`. The `except Exception: pass` also means that if `publish_turn_event` itself ever started failing, we would never learn. Fix is one line plus a regression test (`test_fire_telemetry_schedules_without_typeerror`); it must land in the same PR as the identity work because that PR changes the same call.

### 1.3 The fix, layer by layer

**CrystalOS — mint at the request boundary, inject once.**

Mint `turn_id = uuid4()` at the top of `crystal_stream_endpoint` (`crystalos/main.py:1717`), before `stream_fn` is selected (`:1785-1789`). Carry it as a field on `CrystalInput` (`crystal.py:112-155`) rather than a sibling object — `CrystalInput` is already the single thing threaded through every path including the in-process Novu caller (`crystalos/novu_connect/message_processor.py:162`), and adding a field there is byte-identical for absent callers, which is the convention `surface`/`builder_draft` already established (`crystal.py:144-155`).

```python
# CrystalInput (crystal.py:112-155) — additive
turn_id:   str = ""      # server-minted per-turn id; "" = legacy caller
thread_id: str | None = None
locale:    str = "en"    # §7
```

Do **not** edit the ~24 yield sites. Wrap the generator once in `event_stream()` (`main.py:1791-1807`):

```python
async def event_stream():
    yield f"id: {turn_id}\n"
    yield f"data: {json.dumps({'type':'turn_start','turn_id':turn_id,'thread_id':thread_id,'schema_version':1})}\n\n"
    async for event_json in stream_fn():
        ev = json.loads(event_json)          # already a JSON string at every yield site
        ev['turn_id'] = turn_id
        yield f"id: {turn_id}\n"
        yield f"data: {json.dumps(ev)}\n\n"
    yield "data: [DONE]\n\n"
```

Every yield site in `_run_skill_stream` (`crystal.py:1781-1993`) and `_run_react_loop_streaming` already emits `_json.dumps({...})`, so the parse is safe; the two non-JSON emissions are the literal `[DONE]` (`main.py:1807`) and the exception-path frames (`:1802-1806`), both of which are inside `event_stream` and get the id directly. One helper, one call site. This also gives us a real SSE `id:` line, so `Last-Event-ID` resumption becomes available to any `EventSource`-shaped client for free — the standards version of assistant-ui's resumable-streams feature (`ASSISTANT_UI.md:150`).

**Pass the pre-minted id into the INSERT.** `_write_turn_event` (`turn_publisher.py:79-106`) currently omits `id` from the column list and relies on the column default. Add `id` to `TurnEvent` (`turn_publisher.py:24-42`) and to the INSERT. Add `ON CONFLICT (id) DO NOTHING` so a retried task cannot duplicate.

**Move `_fire_telemetry` before the answer frame — for the row, not the id.** With the id pre-minted we no longer *need* the write to precede the answer, and we should not make the user wait for it. Keep the write fire-and-forget, but move the *scheduling* to immediately after `_skill_synthesis` returns (`crystal.py:1955-1958`) so the row exists by the time a user can plausibly click a thumbs-up. Set `thread_id` to the real value from §6 and delete the `# nullable after migration 009` comment at `crystal.py:1645`.

**Express — pass through, plus one header and one new route.**

The proxy byte-copies (`backend/src/routes/experience.ts:820-822`), so it needs no parsing for the SSE frames. Three additions:

1. Set `X-Crystal-Turn-Id` before `res.flushHeaders()` (`experience.ts:654`). This requires minting the turn id **in Express**, not CrystalOS, because headers flush before the upstream `fetch` at `:789`. **Decision: Express mints `turn_id` and sends it down in `agentBody`;** CrystalOS uses the supplied value and only mints its own when absent (the in-process Novu path). This is strictly better than CrystalOS minting: Express is the only layer that can put it on a response header, it already owns `org_id`/`user_id` injection (`:706`, `:733-736`), and it makes the id available to the non-SSE fallback route (`api.crystalChat2` → `POST /api/experience/crystal`) with no second mechanism.
2. Mint a separate `message_id` for the **user** turn and echo it in the same header set (`X-Crystal-User-Message-Id`) — the frontend needs an id for the message it optimistically appended before the stream opened.
3. Add `POST /api/crystal/feedback` to Express, proxying to CrystalOS's `crystalos/routers/feedback.py:58` with `X-Internal-Key`. The upstream route requires `require_internal_key` (`feedback.py:61`), so a browser can never call it directly — **the missing Express route is the second half of why feedback is uncallable**, and it is not mentioned anywhere in the evidence base. Grep confirms zero occurrences of `crystal/feedback` or `turn_event_id` anywhere in `backend/src` or `app/src`.

**Frontend — what it keys on.**

- `message.id` for an assistant message = `turn_id` from the `turn_start` frame (or the `X-Crystal-Turn-Id` header on the REST fallback). Replaces `crypto.randomUUID()` at `CrystalPanel.tsx:453` and `:471`.
- `message.id` for a user message = `X-Crystal-User-Message-Id`, replacing `:537`/`:550`/`:566`.
- Client-constructed messages that never had a server turn (`note()` at `:748-752`, and the local error branch) keep `crypto.randomUUID()` with a `local:` prefix so the adapter can tell them apart and suppress edit/regenerate/feedback affordances on them.
- Feedback POSTs `turn_id` as `turn_event_id`. **Because we mint the id before the row is written, the client can send feedback before the row lands.** `crystal_feedback.turn_event_id` is `UUID REFERENCES crystal_turn_events(id) ON DELETE SET NULL` (`20260623000002_crystal_telemetry.sql:34`) — a not-yet-existing parent is an FK violation, not a null. Mitigation: the Express feedback route retries once after 500 ms on `23503`, and the CrystalOS insert is ordered before the answer frame per above. Sam should assert this ordering in the contract test; it is the one genuine race the design introduces.

### 1.4 What this un-bricks

| Feature | Why it is dead today | After |
|---|---|---|
| `POST /api/crystal/feedback` (`feedback.py:58`) | Requires `turn_event_id` (`feedback.py:21`) minted after the answer, **and** has no Express proxy route. Complete implementation with a 3-negative-signals quality-regression detector (`feedback.py:80-95`) and a test suite (`crystalos/tests/test_feedback_api.py`). Zero callers. | Callable. Thumbs up/down feeds `skill_quality_metrics.positive_signals`/`negative_signals` (`20260623000002_crystal_telemetry.sql:52-58`) for the first time. |
| `crystal_debug_traces` (`20260623000002_crystal_telemetry.sql:79-87`) | `turn_event_id` unjoinable for the same reason; and `store_trace` is a dropped query param (§8.3). | Joinable per-turn provenance. Fixing the query-param drop and the id in the same release makes the admin trace viewer real. |
| `crystal_turn_events.thread_id` | `None` by design (`crystal.py:1645`) | Real, from §6. Migration `009`'s `DROP NOT NULL` (`:12-14`) becomes reversible. |

### 1.5 Cost

| Work | Days |
|---|---|
| CrystalOS: `turn_id`/`thread_id`/`locale` on `CrystalInput`; `event_stream` wrapper + `turn_start` frame; tests per `crystalos/CLAUDE.md:195-206` | 1.5 |
| Telemetry: explicit `id` on INSERT + `ON CONFLICT`; fix the `create_task(None)` bug; move scheduling ahead of the answer frame | 0.75 |
| Express: mint both ids, response headers, `agentBody` pass-through, new `/api/crystal/feedback` proxy route | 1.0 |
| Frontend: adopt server ids at the 5 `crypto.randomUUID()` sites, `local:` prefix convention | 0.5 |
| Cross-seam contract tests (with Sam) | 1.0 |
| Reverse migration `009` — restore `thread_id NOT NULL` after §6 lands | 0.25 (deferred to G4) |
| **Total** | **≈5.5 d** — held from my prior estimate; the Express route and the `TypeError` fix absorbed into the same PRs |

---

## 2. The `generative-ui` emit contract

This is the primary new work and the highest-risk design decision in the document. I am making four calls: **where** the spec is produced, **how** it is grounded, **which channel** it validates on, and **what happens to `render_hint:'document'`**.

### 2.1 First — the abandoned-precedent question is answered, and the answer is favourable

`README.md:123-127` asks that the two abandoned rich-content attempts be explained before generative UI is funded, on the theory that "if the cause was product judgment rather than engineering difficulty, a library won't change the outcome."

**For `MiniNPSChart` the cause was neither.** The removal comment is explicit (`app/src/components/CrystalPanel.tsx:2543`):

```
// Removed: MiniNPSChart (was hardcoded fake data tied to buildDemoResponse)
```

It sits between two sibling comments (`:2542`, `:2544`) removing `buildDemoResponse` and the demo bubbles, and the block closes *"Crystal now calls the real /api/insights/:surveyId/crystal endpoint."* The chart was deleted as part of **removing the mock-data path**, because it had no real data source — not because charts were judged unwanted. That is exactly the gap this workstream fills, and it means the precedent argues *for* funding, not against.

**For `render_hint:'document'` the cause was a silent-drop bug in the emitter, diagnosed in §2.5.** Also not product judgment.

Two abandoned attempts, two mechanical causes, zero evidence of a product decision against rich content. I consider the concern in `README.md:127` retired.

### 2.2 Where the spec is produced — and by what

**Two tiers, both server-materialised. Tier 0 ships first and is not optional.**

| Tier | Who decides a chart appears | Who decides the data | Gate |
|---|---|---|---|
| **Tier 0 — deterministic** | A pure function over `tool_results` (`_derive_viz`), no LLM | Server, from the tool result | **G0** |
| **Tier 1 — model-referenced** | The skill LLM, by emitting a `viz` *reference* | Server, from the same tool result | **G3** |

**Tier 0.** After `_skill_synthesis` returns (`crystal.py:1955-1958`) and before the `answer` frame is yielded (`:1968-1974`), run `_derive_viz(tool_results, inp)` — a deterministic post-synthesis transform. It matches on tool name and result shape against a fixed table and emits at most one spec. Concretely: if `tool_results` contains a successful `get_metric_history` whose `history` array has ≥ 3 rows with a non-null `nps_score`, emit a line chart. `get_metric_history` already returns exactly the right shape (`crystalos/crystal/tools.py:231`): `{"history": [{nps_score, csat_score, ces_score, response_count, captured_at}], "count", "days"}` with floats coerced (`:224-229`) and timestamps stringified (`:228-229`).

Tier 0 is not a stepping stone to be thrown away. It is the correct permanent answer for the cases where "the user asked about NPS over time and we fetched the series" — no model judgment is needed or wanted there, and it costs zero tokens, zero latency, and zero eval risk.

**Tier 1.** The skill emits a reference only, inside its existing single JSON object. See §2.3.

**Not a tool.** A `render_chart` tool would put the emission *before* synthesis and before the eval gate, would need an LLM tool-selection turn the skill-first architecture deliberately removed, and would be unreachable anyway: the skill path's prefetch candidates are the intersection of a hardcoded `PRIORITY` list with the skill's `allowed-tools` (`crystal.py:1905-1910`, `:1569`, `:1545`), and no `PRIORITY` list contains a rendering tool. Rejected.

### 2.3 How it stays grounded — **the model emits a reference; the server materialises the data**

This is the most important decision in the document, so here is the full reasoning rather than the conclusion.

**The rule: no numeric or categorical data point in a rendered chart may originate from model output.** Crystal's differentiator is that every claim traces to a real response (`crystalos/skills/crystal-analyst/SKILL.md:30` — *"Every factual claim you make must be supported by a tool result"*). A model-authored `data: [{x, y}, …]` array is a claim with no citation and no way to acquire one. A hallucinated trend line is materially worse than a hallucinated sentence, because a chart reads as measurement rather than as prose.

**The mechanism: make it structurally impossible, not evaluated.** The Pydantic model has no data field at all, and it forbids extras:

```python
class VizSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tool: str                      # must be a key of tool_result_map
    path: str                      # whitelisted per tool — not arbitrary JSONPath

class VizSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: int = 1
    kind:   Literal["line","bar","stacked_bar","donut","sparkline","kpi","table","report_card"]
    title:  str
    source: VizSource
    x:      VizAxis  | None = None
    series: list[VizSeries] = []          # each is {field, label} — field names, never values
    annotations: list[VizAnnotation] = [] # {at, label, citation_id} — citation_id must resolve
```

`extra="forbid"` means a model that helpfully includes `"data": [...]` produces a `ValidationError`, which `_normalize_skill_output`'s per-item `try/except` (`crystal.py:1207-1214`, the same pattern already used for proposals) turns into "this spec is dropped, the answer still ships." Fail-closed, no partial trust.

**The materialiser.** `_materialise_viz(specs, tool_results, turn_id)` runs after synthesis, with access to the same `tool_result_map` the skill was given (`crystal.py:1272-1276`, keyed by tool name). For each spec:

1. Resolve `source.tool` in `tool_result_map`. Absent → drop, log `viz_source_unavailable`. This is the check that catches a model referencing a tool that was never called.
2. Resolve `source.path` against a **closed whitelist of `(tool, path) → allowed field names`**, not a path expression. Initial table:

   | tool | path | x fields | y fields |
   |---|---|---|---|
   | `get_metric_history` | `history` | `captured_at` | `nps_score`, `csat_score`, `ces_score`, `response_count` |
   | `get_topic_details` | `topics` | `name` | `volume`, `sentiment_score` |
   | `get_segment_breakdown` | `segments` | `segment` | `score`, `n` |
   | `get_driver_analysis` | `drivers` | `driver` | `impact`, `correlation` |
   | `get_insight_report` | `$root` | — | — (`report_card`, §2.5) |
   | `get_tag_report` | `$root` | — | — (`report_card`) |

   Any `(tool, path)` or field name outside the table → drop the spec. Widening the table is a reviewed change with a test, which is the point.
3. Copy the real rows out of the tool result. Cap at 200 points; downsample deterministically (every *n*th) beyond that, and record `downsampled: true`.
4. Attach a provenance block to the materialised props:

   ```json
   "grounding": { "tool": "get_metric_history", "args": {"survey_id":"…","days":90},
                  "row_count": 47, "materialised_at": "…", "turn_id": "…", "tier": 1 }
   ```

   This is what makes a chart auditable in the same way a citation is, and it is what the provenance panel and Sam's integrity gate read. It also means a chart persisted in a thread can be re-verified later against the same tool.

**Why not let the model emit data and validate it against the tool result?** Because equality checking floats and timestamps across a JSON round-trip is a fuzzy comparison, and every fuzzy comparison eventually gets a tolerance, and every tolerance eventually gets widened. Reference-only has no tolerance to widen.

**Why the EVALS harness cannot be the grounding gate — a hard finding.** I checked whether "every `viz.source.tool` appears in `tool_results`" could be an EVALS criterion. It cannot. `_is_structural_criterion` (`crystalos/lib/skill_runtime.py:59-62`) matches against a fixed `STRUCTURAL_KEYWORDS` set (`:53-56`), and `_eval_structural` (`skill_runtime.py:475-517`) is a fixed ladder of pattern matchers whose **default return is `0.8` — a soft pass** (`:517`). A criterion phrased as a grounding assertion would match no branch, score 0.8 vacuously, and pass. A semantic phrasing would route to the LLM judge (`:437-473`) whose error fallback is `0.5` (`:471-473`) and which cannot see `tool_results` in a form it could join. **Grounding must be enforced in Python, deterministically, or not at all.** That is the strongest argument for reference-only materialisation, and it is not in any prior document.

### 2.4 How it survives the eval gate — and the prerequisite bug that must be fixed first

**Channel decision: `viz` validates *inside* `CrystalOutput`, on the same atomic object as the answer.**

Rationale: eval failure discards the whole skill output (`crystal.py:1352-1359` returns `None`; `_run_skill_stream` falls through to a *different* LLM call at `:1978-1989`; the retry inside `SkillRuntime` replaces `output_raw` entirely at `skill_runtime.py:174-180`). If `viz` were a separate channel emitted independently, a discarded answer would leave an orphaned chart attached to prose that no longer says what the chart shows. One object, one gate, one fate. A separate channel is only defensible for Tier 0, which never passes through the LLM at all — and even there I keep it on the answer frame so the frontend has exactly one place to look.

So:

```python
class CrystalOutput(BaseModel):        # crystal.py:180-190
    answer: str
    citations: list[str] = []
    suggestions: list[str] = []
    insight_refs: list[str] = []
    action_proposals: list[ActionProposal] = []
    viz: list[VizSpec] = []            # NEW — materialised, never model data
```

And `_normalize_skill_output` (`crystal.py:1168-1222`) must explicitly copy it. **This is not optional plumbing — it is the exact mechanism that killed `documents[]`.** `_SkillOutput` is `extra="allow"` (`skill_runtime.py:30-32`), so the model's extra keys survive into `result.output`; but `CrystalOutput` uses Pydantic's default `extra="ignore"`, and `_normalize_skill_output` hand-copies six fields by name (`:1216-1222`). Anything not named there is silently dropped. Any new channel must be added in **both** places or it will appear to work in unit tests of the skill and vanish in production.

**PREREQUISITE — the EVALS `non-empty` scorer must be fixed before `viz` is added, or every chart-free turn will fail a must-pass criterion.**

`crystal-analyst`'s E2 is *"answer, citations, suggestions present and non-empty"*, weight 20, threshold **must pass** (`crystalos/skills/crystal-analyst/EVALS.md` row E2). `_eval_structural`'s handler for it (`skill_runtime.py:484-487`) is:

```python
if "required fields" in desc or "non-empty" in desc:
    non_empty = sum(1 for v in output.values() if v not in (None, "", [], {}))
    return min(1.0, non_empty / max(len(output), 1))
```

It ignores the field names in the criterion and scores **every key in the output dict**. `must pass` requires `score < 1.0` to fail (`skill_runtime.py:384-388`). Therefore:

- Any empty value on *any* output key fails a must-pass criterion → forced retry → if the retry is also empty, the entire skill output is discarded and a different LLM call answers (`crystal.py:1352-1359` → `:1978-1989`).
- `crystal-analyst`'s own SKILL.md tells the model *"omit it (or use `[]`)"* for `action_proposals` (`SKILL.md:82-84`). **Choosing `[]` fails the gate.** This is live today and is my best explanation for why skill-path proposals are rare in practice.
- Because `_SkillOutput` allows extras, any spurious empty key the model invents also fails a must-pass criterion.
- Adding `viz` guarantees this failure on every turn without a chart.

Fix (0.5 d, standalone bug): parse the field list out of the criterion text and score only those fields. The criterion already names them — `"answer, citations, suggestions present and non-empty"`. Regression tests: `test_eval_structural_non_empty_ignores_undeclared_fields`, and `test_action_proposals_empty_list_does_not_fail_e2`. **This is a G0 item.** It is also, independently, the highest-value 4 hours in this plan.

### 2.5 The `render_hint:'document'` path — **subsume, and reuse the client component**

Ground truth. `render_hint: 'document'` appears at six sites, all inside tool-result dicts (`crystalos/crystal/tools.py:2892`, `:2942`, `:3509`, `:3570`, plus docstrings at `:2854`, `:3473`) — `execute_get_insight_report` and `execute_get_tag_report`. The `answer` frame is built with exactly four keys at `crystal.py:1969-1974` and `:1984-1989`, and five at `main.py:1804`. None is `documents`. The client half is fully merged and live: `Message.documents` (`CrystalPanel.tsx:41`), parsed at `:416-417`, read at `:449`, stored at `:459`, rendered to `InsightDocumentCard` at `:2109-2113`. **A complete consumer with no producer** — the same silent-drop failure described in §2.4, one layer up.

**Decision: subsume it into `viz`, and reuse `InsightDocumentCard` as the registry component for `kind: "report_card"`.**

- `_derive_viz` (Tier 0) emits `{kind:"report_card", source:{tool:"get_insight_report", path:"$root"}}` whenever a `get_insight_report` / `get_tag_report` result carries `render_hint == 'document'`. The materialiser projects the whitelisted subset of that result (`report_id`, `title`, `executive_summary`, `themes`, `insights`, `nps`/`csat`/`ces`, `trust_score_avg`, `citations_count`, `report_url`, `document_url` — all present at `tools.py:2919-2942`).
- **Delete** `Message.documents` and the `event.documents` branch (`CrystalPanel.tsx:41`, `:416-417`, `:449`, `:459`) — one channel, not two.
- **Keep** `InsightDocumentCard.tsx` (130 LOC) and register it under `report_card`. Nadia's registry gets a working, styled, already-reviewed component for free, and the previously-unreachable code becomes the first non-chart proof that the registry is not chart-specific.

Reasons to subsume rather than emit `documents[]` separately: one versioning story, one grounding rule, one place the frontend looks, and it turns "decide: emit or delete" (my prior §5(c)) into a decision that costs nothing extra because the materialiser already exists. Net cost of the report card once `viz` lands: **~0.5 d**, down from the 0.5 d I previously quoted for a standalone `documents[]` emitter — with the versioning and provenance thrown in.

### 2.6 Schema versioning — so a registry change cannot break an old thread

Precedent exists: `context_state` carries `"schema_version": 2` (`crystalos/lib/memory.py:249`, documented at `20260603000003_crystal_threads_context_state.sql:22-25`). Use the same convention.

Rules, in order of importance:

1. **CrystalOS emits a neutral, versioned `viz` payload. It does *not* emit assistant-ui's `{type:"generative-ui", spec:{root:{component, props, children}}}` shape.** The frontend adapter translates. Three reasons: assistant-ui's identity/metadata surface is `unstable_`-prefixed and may change in a patch release (`README.md:120`, `ASSISTANT_UI.md:24`, `:67`); CrystalOS also serves the Novu path (`message_processor.py:162-167`) which must be able to ignore `viz` rather than parse a React component tree; and my own prior note stands (`ASSESSMENT_CRYSTALOS.md:341`) — do not shape a server contract around a pre-1.0 library's field names. **This is the isolation layer `README.md:90` asks for, placed at the right seam.**
2. **`kind` is a closed server-side `Literal`; the frontend owns a total mapping from `kind` to component name.** `README.md:119` warns that an unknown component name throws `GenerativeUIRenderError`. Under this design an unknown *component name* can never reach the registry, because CrystalOS never emits component names — only a `kind` from an enum the frontend enumerates exhaustively at compile time. This is the single most valuable safety property of the whole design and it costs nothing. **Registry allowlist owner: Nadia; enum owner: me; parity enforced by the same generated-union test as §3.4.**
3. **Persist the materialised props, not the reference.** When a thread is stored (§6), store the resolved data. A chart in a 3-month-old thread must render without re-running a tool whose result shape may have changed, and without re-authorising data the user may no longer be able to see. Corollary: thread storage inherits the same retention rules as the data it materialised — flagged as a product/privacy decision in §11.
4. **Unknown `schema_version` or unknown `kind` degrades, never throws.** The frontend resolver keeps N and N−1, and falls back to rendering the spec's `title` as plain text with a "chart unavailable" note. Server-side, a bumped `schema_version` is a new field-compatible shape only; a breaking change gets a new `kind`.
5. **Persisted specs are never re-validated against the current Pydantic model.** They were validated at emit time; re-validating them later would make a model change retroactively corrupt history.

### 2.7 Skill-side wiring for Tier 1 (G3)

Add to `crystal-analyst`'s output schema (`SKILL.md:63-81`) and to a new `## Visualisation` section:

- Emit `viz` **only** when the answer's central claim is a comparison, a trend, or a distribution that you have a tool result for.
- Emit **at most one** spec.
- You may reference only tools listed in `tool_results` for this turn.
- You may reference only field names present in that tool's result.
- **Never write data values.** The `viz` object has no data field; a chart's numbers come from the tool result the server already holds.
- Omit the key entirely when not charting.

Add EVALS criterion E6, weight 10, threshold `>= 0.80`, phrased semantically (*"when viz is present, the answer's main claim is the same claim the chart shows"*) so it routes to the LLM judge. **E6 must not be `must pass`** — the judge's error fallback is `0.5` (`skill_runtime.py:471-473`), and a must-pass criterion on a judge that fails open-at-0.5 converts an LLM hiccup into a discarded turn. Note this adds a **fourth** sequential judge call to `crystal-analyst`; do not add it until §8.2 has parallelised the criteria loop.

### 2.8 Cost

| Work | Days | Gate |
|---|---|---|
| `_eval_structural` non-empty fix + 2 regression tests (**prerequisite**) | 0.5 | G0 |
| `VizSpec`/`VizSource`/`VizSeries` models; `viz` on `CrystalOutput`; explicit copy in `_normalize_skill_output`; unit tests | 0.75 | G0 |
| `_derive_viz` Tier 0 for `get_metric_history` + `_materialise_viz` + whitelist table + provenance block | 1.0 | G0 |
| Express: no change (byte-copy). Feature flag `CRYSTAL_VIZ_ENABLED` read server-side | 0.25 | G0 |
| Tier 0 widening: `get_topic_details`, `get_segment_breakdown`, `get_driver_analysis`, `report_card` subsume | 1.0 | G3 |
| Tier 1: SKILL.md schema + prompt section, E6, reference-resolution tests, drop-path tests | 1.5 | G3 |
| **Total** | **≈5.0 d** (2.5 in G0, 2.5 in G3) | |

---

## 3. Proposals — re-derived under the new plan

### 3.1 The constraints have not changed; the target has

Re-verified, all still true:

- **The tool-based emitter is doubly unreachable.** `_extract_action_proposals` (`crystal.py:972-984`) is called from exactly one site, `_run_react_loop_streaming` (`crystal.py:1453`), which requires `legacy=true`. The proxy's upstream `fetch` (`experience.ts:789`) appends no query string, so `legacy` is always `False` at `main.py:1722`. It *additionally* requires `user_role in ("admin","brand_admin")` (`main.py:1747`), and the browser never sends `user_role` (§5).
- **`crystal-analyst` has zero action tools** (`SKILL.md:13` — nine read-only `get_*` tools).
  *Correction to my prior assessment:* `workflow-analyst/SKILL.md:38` **does** list `propose_workflow`. It is still unreachable in the stream path, because prefetch candidates are `PRIORITY ∩ allowed_tools` (`crystal.py:1905-1910`) and no `PRIORITY` list contains a `propose_*` tool. So the conclusion holds, but "zero action tools in any skill" was wrong.
- **Real tool calls would emit before the eval gate.** A mid-turn tool call ships before synthesis and before `_check_evals`, putting an unvetted write-proposal into a confirm-card whose entire purpose is the safety boundary (`requires_confirmation: bool = True  # always True — safety guarantee`, `crystal.py:173`).
- **`novu_connect/message_processor.py:162` has no user who can click.** It calls `crystal_agent.run(inp)` in-process and returns `output.answer` as a bare string for Slack/Teams/WhatsApp/email (`:163-167`). A `requires-action` part awaiting a human result there blocks forever or needs an auto-decline policy.

### 3.2 Ruling — unchanged on tool *calls*, upgraded on tool *shape*

**No to model-chosen tool calls.** Every reason above survives contact with the migration; none of them was a cost argument, so `message_id` landing does not change them.

**Yes to server-minted proposals emitted in the exact shape `ToolCallMessagePartComponent` consumes.** This is stronger than my prior "server-minted objects" position, because `ASSISTANT_UI.md:116-128` gives the precise prop contract and I can now mint against it directly rather than asking Nadia to fabricate parts.

CrystalOS emits, inside the terminal `answer` frame:

```json
"action_proposals": [{
  "tool_call_id": "<uuid>",              // assistant-ui toolCallId
  "tool_name":    "propose_workflow",    // registry key — see below
  "proposal_id":  "<uuid>",              // funnel identity (§4)
  "turn_id":      "<uuid>",              // §1
  "type":         "create_workflow",     // StrEnum (§3.4)
  "status":       "requires-action",     // assistant-ui ToolCallMessagePartStatus
  "args":         { "title": "...", "description": "...", "cta_label": "Apply",
                    "params": {...}, "priority": "high", "estimated_time": "5 min",
                    "business_rationale": "..." },
  "requires_confirmation": true
}]
```

Four deliberate choices:

1. **`tool_name` = `"propose_" + <tool-vocabulary name>`**, matching the existing `ACTION_TOOL_NAMES` set (`crystalos/crystal/registry.py:1009-1016`). Nadia's registry keys on `tool_name`, which means the client is written against the same vocabulary a real tool call would use. If we ever do enable model-chosen action tools, the client needs **zero** changes. This is how we keep the door open without walking through it.
2. **`status: "requires-action"` is server-set**, mapping to `ToolCallMessagePartStatus` (`ASSISTANT_UI.md:119`). `addResult` (`:124`) on the frontend becomes `executeAction` + `recordProposalOutcome`, and the `interrupt: {type:"human"}` shape (`:126`, `:131`) describes what a confirm-card *is*. This is the one place the library models something Crystal actually does, and it now models it exactly.
3. **`args` is a nested object, not flat.** `ToolCallMessagePartProps.args` is a single typed object; flattening proposal fields to the top level would force the adapter to reconstruct it. Costs nothing to get right now.
4. **Fold `action_proposals` into the terminal `answer` frame and delete the separate SSE event.** Today the separate frame is emitted at `crystal.py:1961-1965`, **before** the answer at `:1968-1974` (and in the legacy path at `:1455` / `:1464-1467`, seconds earlier). assistant-ui message parts belong to one message; a proposal that arrives before its message has no message to attach to. I previously offered this as a concession "pending Nadia" — under the new plan it is **required**, ~0.5 d, and strictly better framing regardless of chassis.

### 3.3 Non-interactive mode — honour it up front

`_materialise_viz` and the proposal minting both run inside `_run_skill_stream`. `CrystalAgent.run` (`crystal.py:2003-2011`) is a separate path used by Novu. Rule: **proposals and viz are always *collected* on `CrystalOutput`, never *awaited*.** `message_processor.py:163-167` reads only `output.answer`, so it stays byte-identical and simply ignores both new fields. Add a test asserting that (`test_novu_path_ignores_viz_and_proposals`). Cheap now, expensive to retrofit — this is the one thing that would have broken under a real tool-call design.

### 3.4 `ActionProposalType` — CrystalOS becomes the source of truth

`app/src/types/index.ts:782-807` is the only enumeration. **Corrected count: 21 members, not 25.** CrystalOS validates `ActionProposal.type` as a free `str` (`crystal.py:165`), whose own comment advertises `workflow` and `template` as valid.

Drift, verified by enumerating the dispatcher's `case` labels (`CrystalPanel.tsx:770-1011`): 18 types are handled; **`workflow`, `template`, `export_insights` are declared in TS with no case.** They fall to `default` at `CrystalPanel.tsx:1009-1011` — which calls `track('failed', undefined, 'unhandled proposal type: …')`. **So type drift does not merely fail silently; it writes false `failed` rows into the outcome funnel.** That is a data-integrity defect, not just a dead branch, and it belongs to §4 as much as here.

The asymmetry is real: `_PROPOSAL_TYPE_ALIASES` maps `workflow → create_workflow` (`crystal.py:934`), and `_normalize_proposal` applies the alias only via `out["type"] = _PROPOSAL_TYPE_ALIASES.get(ptype, ptype)` where `ptype` is `out.get("type") or out.get("proposal_type")` (`crystal.py:962-963`). A **tool**-emitted `proposal_type: "workflow"` (three sites: `tools.py:1101`, `:1114`, `:1127`) aliases correctly. A **skill**-emitted `type: "workflow"` also aliases — but a skill emitting a type absent from the alias table passes through unmapped and lands on `default`.

Fix: `StrEnum` on `ActionProposal.type`; generate the TS union from it in CI; parity test; correct the misleading comment at `crystal.py:165`. **This is also the `viz.kind` mechanism (§2.6 rule 2)** — one generated-union test covers both enums, so the marginal cost of the `viz` half is zero.

### 3.5 Does the migration make the closed loop stronger or weaker?

**Stronger — and this is a reversal of my prior answer.** My previous "weaker, marginally" rested entirely on opportunity cost: a migration would rewrite *propose*/*confirm*/*render* and leave *record outcome* broken. Under this plan the funnel repair is inside the migration's G1 gate (`README.md:100`) and cannot be skipped without failing a gate. The opportunity-cost argument does not survive that. With `turn_id` on the proposal row, `proposal_id` server-minted, `emitted` written, and feedback callable, *record outcome* is repaired **as a condition of shipping the migration** rather than in spite of it. That is a better outcome than my sequencing produced.

### 3.6 Cost

| Work | Days |
|---|---|
| `_normalize_proposal` → `_mint_proposal`: `uuid4` `proposal_id`, `tool_call_id`, `turn_id`, `status`, nested `args`; keep the alias table | 1.0 |
| Fold into the `answer` frame; delete the `action_proposals` SSE event from both paths (`crystal.py:1961-1965`, `:1455`, `:1464-1467`) | 0.5 |
| `StrEnum` + generated TS union + parity test (covers `viz.kind` too) | 1.0 |
| Handle or delete `workflow`/`template`/`export_insights`; stop them writing false `failed` rows | 0.5 |
| Novu non-interactive test; `_extract_action_proposals` shape update for the legacy path | 0.5 |
| **Total** | **≈3.5 d** |

---

## 4. Funnel repair — gate G1

### 4.1 The defect, re-verified end to end

The upsert key is `(org_id, proposal_key)` (`backend/src/routes/insights.ts:2316-2321`, unique partial index at `20260623000010_crystal_action_proposals.sql:29-31`), and `proposal_key = proposal.id` (`CrystalPanel.tsx:762`, `:1096`).

For every browser-visible proposal, `proposal.id` is a **title-derived slug**, because the skill output schema has no `id` field (`SKILL.md:63-81`) and `_normalize_proposal` synthesises one (`crystal.py:964-966`):

```python
if not out.get("id"):
    slug = _re.sub(r"[^a-z0-9]+", "-", (out.get("title") or out["type"]).lower()).strip("-")[:48]
    out["id"] = slug or "proposal"
```

Consequences, all live:

- **Repeat emissions collapse.** "Create a detractor follow-up survey" proposed to the same org next week produces the same slug, hits `ON CONFLICT`, and updates the existing row (`insights.ts:2317-2322`). The funnel's denominators are structurally wrong.
- **`dismissed` can overwrite `succeeded`.** `DO UPDATE SET status = EXCLUDED.status` (`:2319`) is unconditional, with no lifecycle guard. Dismissing a re-offered proposal rewrites the successful outcome of the earlier one.
- **`emitted` is never written.** The client writes `accepted` (`CrystalPanel.tsx:774`), then `succeeded`/`failed`, or `dismissed` (`:1094-1102`). Nothing writes `emitted`, so the column default (`20260623000010:17`) is unreachable and the top of the funnel does not exist. We cannot state an accept rate.
- **No `CHECK` on `status`.** The five legal values live in a comment only (`20260623000010:17`, `:36`).
- **`GET .../crystal/proposals` (`insights.ts:2345`) has no caller.**
- **Type drift writes false `failed` rows** (§3.4) — the `default` branch at `CrystalPanel.tsx:1009-1011` calls `track('failed', …)`.
- **Org-scope proposals record against `'global'`.** `api.recordProposalOutcome(surveyId ?? 'global', …)` (`CrystalPanel.tsx:761`, `:1096`) and the route is `POST /:surveyId/crystal/proposals` (`insights.ts:2285`), so `survey_id` is the literal string `'global'` for every org-scope turn. Any per-survey funnel query silently excludes them.

### 4.2 The fix

**Schema — migration `20260805000001_crystal_action_proposals_identity.sql`:**

```sql
ALTER TABLE crystal_action_proposals
    ADD COLUMN IF NOT EXISTS proposal_id      UUID,
    ADD COLUMN IF NOT EXISTS turn_id          UUID,
    ADD COLUMN IF NOT EXISTS thread_id        TEXT,
    ADD COLUMN IF NOT EXISTS tool_call_id     UUID,
    ADD COLUMN IF NOT EXISTS identity_scheme  TEXT NOT NULL DEFAULT 'uuid';

-- Mark every pre-existing row as belonging to the old, collapsed key scheme.
UPDATE crystal_action_proposals SET identity_scheme = 'slug' WHERE proposal_id IS NULL;

-- New identity. Partial so the backfill below can proceed row by row.
CREATE UNIQUE INDEX IF NOT EXISTS crystal_action_proposals_proposal_id_uniq
    ON crystal_action_proposals (proposal_id) WHERE proposal_id IS NOT NULL;

-- Status CHECK added NOT VALID so the migration cannot fail on dirty history.
ALTER TABLE crystal_action_proposals
    ADD CONSTRAINT crystal_action_proposals_status_chk
    CHECK (status IN ('emitted','accepted','dismissed','succeeded','failed')) NOT VALID;

CREATE INDEX IF NOT EXISTS crystal_action_proposals_turn_idx
    ON crystal_action_proposals (turn_id) WHERE turn_id IS NOT NULL;
```

`NOT VALID` is deliberate: existing rows have no `CHECK` and may contain anything. It enforces the constraint on all *new* writes immediately while deferring validation of history. A follow-up `VALIDATE CONSTRAINT` runs only after an audit query returns zero offending rows. Adding a plain `CHECK` would either fail the migration or force a destructive `UPDATE` of real outcome data.

**Backend — `POST /:surveyId/crystal/proposals` (`insights.ts:2285-2342`):**
- Accept `proposalId`, `turnId`, `threadId`, `toolCallId`.
- `ON CONFLICT (proposal_id)` instead of `(org_id, proposal_key)`.
- **Guard the status transition.** Replace unconditional `SET status = EXCLUDED.status` with a monotonic lifecycle: `emitted → accepted → succeeded|failed`, and `emitted → dismissed`. Implement as a rank comparison in the `DO UPDATE ... WHERE` clause so a late `dismissed` can never overwrite `succeeded`. This is the actual data-loss fix; the new key only prevents *cross-proposal* collisions.
- Keep `proposal_key` written for one release for rollback (§4.4).
- Accept `scope` and stop writing the literal `'global'`; add a nullable `scope` column or route org-scope writes to a scope-agnostic path.

**CrystalOS — write `emitted` server-side at emission time.** New `crystalos/lib/proposal_publisher.py`, called from `_run_skill_stream` immediately **before** the `answer` frame is yielded, `INSERT ... ON CONFLICT (proposal_id) DO NOTHING`. Two rules:

1. **Not fire-and-forget.** `emitted` is the funnel denominator; a dropped denominator row inflates the accept rate. Await it, with a 250 ms timeout and a warning-plus-continue on failure. This is the opposite policy from `TurnEvent` (`turn_publisher.py:107-121`) and the difference is intentional: a lost telemetry row costs one sample, a lost denominator row corrupts a rate.
2. It runs **inside** the eval gate — after `_skill_synthesis` returns non-`None` (the `if skill_out is not None:` branch at `crystal.py:1960`) and before the `answer` frame at `:1968`. A discarded turn emits no proposals and therefore writes no `emitted` rows. Nothing to reconcile.

Whether the `emitted` write goes direct-to-Postgres from CrystalOS or through an Express internal route is a bridge-consistency question: root `CLAUDE.md` says *"All writes go through the Express API,"* but CrystalOS already writes `crystal_turn_events` directly (`turn_publisher.py:79`). **Decision: direct, matching the existing telemetry precedent**, and note the inconsistency for a separate architectural cleanup rather than resolving it inside a migration PR.

### 4.3 Migration discontinuity — the part that is not a code change

Existing rows carry slug keys and are already merged. **There is no way to un-merge them.** Any historical accept rate computed from them is wrong and cannot be corrected. Say this out loud to whoever consumes the number before the cutover, not after.

**Measure the damage first (shadow week).** Before switching the unique index, run one week where CrystalOS writes `emitted` rows with `proposal_id` + `turn_id` while the client still sends `proposalKey`. Then:

```sql
-- How many slug keys were shared across distinct turns?
SELECT proposal_key, COUNT(DISTINCT turn_id) AS turns, COUNT(*) AS rows
FROM crystal_action_proposals
WHERE turn_id IS NOT NULL
GROUP BY proposal_key HAVING COUNT(DISTINCT turn_id) > 1
ORDER BY turns DESC;

-- How often did a later dismissed overwrite an earlier succeeded?
SELECT COUNT(*) FROM crystal_action_proposals
WHERE identity_scheme = 'slug' AND status = 'dismissed' AND outcome_ref IS NOT NULL;
```

The second query is a proxy, not proof — `outcome_ref` surviving on a `dismissed` row is the fingerprint of an overwritten success, because `DO UPDATE` preserves `outcome_ref` via `COALESCE` (`insights.ts:2320`) while replacing `status`. It gives Sam a number to put on the gate.

**Metric handling at cutover:**
- **Two series, never one.** `funnel_v1_slug` (`identity_scheme='slug'`) is frozen and archived. `funnel_v2_uuid` starts empty. Do not derive v2 from v1.
- **Expect the reported accept rate to move sharply, and expect the direction to be down.** Today the rate is computed over `accepted + dismissed` only, because `emitted` does not exist — a denominator that omits every proposal the user ignored. Adding real `emitted` rows adds exactly those, so the rate falls. **That is the metric becoming correct, not the product regressing**, and it will look identical to a regression on a dashboard. This needs an owner who agrees in advance (§11).
- **Dated annotation** in whatever surfaces the metric, plus a `docs/` note recording the cutover date and both queries above.
- **Baseline from the first full week post-cutover.** Do not compare across the boundary.
- **Sam's integrity gate** (`TEAM.md:109`): the assertion is not "the rate is unchanged" — it will change. It is: *for every proposal rendered in the new panel, exactly one `emitted` row exists with a `turn_id` that joins to a `crystal_turn_events` row, and no row's status ever moves backwards down the lifecycle rank.* Those are invariants, and invariants survive a cutover in a way rates do not.

### 4.4 Rollback

The new columns are additive and the old partial index survives for one release, so the backend can revert to `ON CONFLICT (org_id, proposal_key)` by redeploying a single file. Drop `proposal_key` and the old index only at G4, after two clean weeks. The `NOT VALID` constraint is droppable without a table rewrite.

### 4.5 Cost

| Work | Days |
|---|---|
| Migration `011` + audit/measurement queries | 0.5 |
| Backend upsert: new key, monotonic status guard, `scope`/`global` fix, tests | 1.0 |
| CrystalOS `proposal_publisher.py` + `emitted` write inside the gate + tests | 0.75 |
| Shadow-week instrumentation + the two measurement queries + writeup | 0.25 |
| **Total** | **≈2.5 d** |

---

## 5. `user_role` — staged, with the audit as the gate

### 5.1 Why this is not a one-line change

`main.py:1743-1745` reads `user_role` from the body and whitelist-validates it. `crystal.py:885-886` resolves permissions from it, and `context.py:26-31` maps roles to permission sets. Un-pinning it therefore hands Crystal a permission set it has **never had in production on the browser path**. I will not recommend the plumbing fix without the audit, and the audit produced three findings that change the shape of the work.

### 5.2 Finding A — the client can already self-assign a role

This is the correction that matters most. My prior assessment said `user_role` "never reaches CrystalOS." That is true of the *frontend*, and false of the *bridge*.

`experience.ts:706` and `:733-736` both build `agentBody` by **spreading the raw client body**: `agentBody = { ...body, org_id: orgId, user_id: userId, scope: effectiveScope }`. A client-supplied `user_role` is therefore forwarded verbatim, and `main.py:1743-1745` accepts it because `"admin"` is in `VALID_ROLES`. Nothing strips it.

So `POST /api/experience/crystal` with `{"user_role": "admin", …}` from any authenticated user grants `data:read, data:export, data:pii, survey:write, workflow:write, admin:read` (`context.py:29`). **The chat path is not pinned to `viewer` by design — it is pinned by the frontend not sending a field, which is not a security control.**

Currently inert, for the reasons in Finding B, but it is a live escalation path and it must be closed **before** anything else in this section. The whitelist at `main.py:1744-1746` is the right defence applied to the wrong source: it defends against invalid values from a source it should not trust at all.

### 5.3 Finding B — the declarative tool-permission filter is a no-op

`TOOL_PERMISSION_MAP` (`crystal.py:659-664`) maps four tool names:

```python
"export_responses": "data:export", "view_respondent_pii": "data:pii",
"configure_alerts": "workflow:write", "manage_survey": "survey:write",
```

**None of these four tools exists anywhere in CrystalOS.** A repo-wide grep for each returns only these four lines. Therefore `_build_filtered_tool_list` (`crystal.py:711-730`), whose contract is *"Tools with no entry in `TOOL_PERMISSION_MAP` are always included"* (`:714`), **filters nothing, for any role.** It is also only called from `_build_system_prompt_agentic` (`crystal.py:763`) — the legacy ReAct prompt — so it does not run on the live path at all.

The **only** live permission check in the codebase is inside a tool body: `execute_get_contact_identity` returns `{"error": "data:pii permission required", "masked": True}` when `"data:pii" not in ctx.effective_perms` (`crystalos/crystal/tools.py:2039-2040`). Registered as `get_contact_identity` (`registry.py:844`).

### 5.4 What the editor role actually unlocks — the enumeration

| Permission | Held by | Enforced anywhere? | Reachable from browser chat? |
|---|---|---|---|
| `data:read` | all roles (`context.py:27-30`) | no | — |
| `data:export` | editor+ | **no** (maps to a non-existent tool) | no |
| `survey:write` | editor+ | **no** (non-existent tool) | no |
| `workflow:write` | editor+ | **no** (non-existent tool) | no |
| `admin:read` | admin+ | **no** | no |
| `data:pii` | **admin, brand_admin only** | **yes** — `tools.py:2039` | **no** — see below |
| `brand:admin` | brand_admin | no | no |

**`editor` unlocks nothing.** All three of its extra permissions map to tools that do not exist.

**`admin` unlocks exactly one thing: real contact PII** (name, email, `account_name`, `segment_attrs`, `consent_given` — `tools.py:2046-2052`) instead of a masked error. And even that is unreachable today, because `get_contact_identity` appears in **no** skill's `allowed-tools` (verified across all 24 `crystalos/skills/*/SKILL.md`) and in no `PRIORITY` prefetch list (`crystal.py:1905-1910`, `:1545`, `:1569`). The skill path's tool set is hardcoded, which is why Finding A is inert.

**Was `viewer` deliberate?** Partly. The `main.py:1741-1743` comment says *"user_role should ultimately come from backend JWT injection; until then, validate against the whitelist to prevent arbitrary role escalation"* — so the whitelist is deliberate and the default is acknowledged as temporary. But `viewer` as the *effective* value is an accident of the frontend not sending the field, not a decision. Two pieces of evidence that it was not intended: `CrystalInput.user_role`'s comment documents `viewer | editor | admin | brand_admin` (`crystal.py:127`) and `CrystalContext.user_role` is `Literal["viewer","editor","admin","brand_admin"]` (`context.py:63`) — yet `main.py:1744`'s `VALID_ROLES` is `{"admin","brand_admin","analyst","viewer"}`. **`editor` is not in the whitelist and would be silently downgraded to `viewer`; `analyst` is in the whitelist but has no `ROLE_PERMISSIONS` entry (`context.py:26-31`), so `_resolve_permissions` returns an empty frozenset — strictly worse than `viewer`.** Three definitions of the role vocabulary, no two agreeing. That is drift, not design.

**Third asymmetry:** the whitelist lives only in the HTTP handler. `message_processor.py:159` sets `user_role="editor"` and calls `crystal_agent.run(inp)` in-process (`:162`), bypassing `main.py` entirely — so the one caller that legitimately sets a role gets no validation, and the value it sets (`editor`) is one the HTTP path would reject. The guard is in the wrong layer.

### 5.5 The staged plan

**Stage 1 — close the hole, keep the pin (G1, 0.5 d). No behaviour change.**
- In `experience.ts`, **delete `user_role` from the spread** before building `agentBody` (both sites: `:706`, `:733-736`). Explicitly: `const { user_role: _ignored, ...safeBody } = body`.
- Derive `user_role` server-side from the Clerk claims / RBAC Express already holds, and forward the derived value — **but keep it pinned to `viewer` behind a flag `CRYSTAL_ROLE_PASSTHROUGH=false`.** The plumbing lands; the privilege does not.
- Move role validation out of the HTTP handler into `_build_ctx` (`crystal.py:885`) so the in-process Novu caller is validated too.
- Reconcile the vocabulary to one list: add `editor` to the whitelist, remove `analyst` or give it a `ROLE_PERMISSIONS` entry, and make `crystal.py:127` / `context.py:63` / `main.py:1744` reference a single source.
- Regression test: a body containing `user_role: "admin"` results in `ctx.user_role == "viewer"`.

**Stage 2 — the audit is the gate (G2, 1.0 d). No code change on the happy path.**
- Delete or repair `TOOL_PERMISSION_MAP` (Finding B). Repair means mapping it to the tool names that actually exist; delete means removing a filter that has never filtered. **Recommend repair**, because the map is the natural place to gate `get_contact_identity` and any future write tool, and deleting it means the next person adds a privileged tool with no gate to hang it on.
- Add a test asserting every key in `TOOL_PERMISSION_MAP` exists in `TOOL_REGISTRY`. This is the defect class, not the defect.
- For every tool that a non-`viewer` role would newly expose, record: does it exist, is it read-only, does it have a test, has it ever executed in production. Today the answer set is `{get_contact_identity}` and it has never executed on the chat path.
- Decide the PII policy (§11 item 3). This is a policy question about what an org admin's copilot may show, not an engineering question.

**Stage 3 — flip the flag (G4, minimum, 0.0 d code). Gated on Stage 2 passing.**
- `CRYSTAL_ROLE_PASSTHROUGH=true`, per-org, staged like any other flag.
- Do **not** flip it in the same release as the `legacy`/`debug` query-param forwarding (§8.3). Forwarding the params re-enables the ReAct path (`main.py:1786`), which is the only path that calls `_build_filtered_tool_list` (`crystal.py:763`) and `_extract_action_proposals` (`:1453`). Together those two changes reactivate a code path that has not run in production against a permission system that has never filtered anything. Separately, each is a small change. Together they are the highest-risk pairing in this plan.

**Total: 1.5 d, of which 1.0 is audit and 0 is the actual un-pinning.**

---

## 6. Thread persistence — gate G3

### 6.1 Four implementations, re-verified

| # | Implementation | Status |
|---|---|---|
| 1 | `crystal_threads` v1 — `thread_key UNIQUE` (`supabase/migrations/20240518000000_insights_v2.sql:42-55`) | **Statically dead.** Written only at `backend/src/routes/insights.ts:1463-1475`, reached only via `api.crystalChat` (`app/src/lib/api.ts:2184-2201`), called only at `CrystalPanel.tsx:602` — inside the `else` of `if (CRYSTAL_STREAMING)`, where `CRYSTAL_STREAMING` is a hardcoded `true` (`:29`, comment: *"Streaming is always enabled — no env flag needed"*) |
| 2 | `crystal_threads` v2 — `UNIQUE (org_id, user_id, survey_id, scope)` (`20240521000002_crystal_threads_v2.sql:9-14`) + `context_state`/`turn_count` (`20260603000003:7-11`); writers `get_or_create_thread`/`append_to_thread` (`crystal.py:217-306`) | **Dead.** Zero production callers |
| 3 | `MemoryManager` L2 (`crystalos/lib/memory.py`) | **Half dead** — see §6.3 |
| 4 | React `useState` (`CrystalPanel.tsx:196`) | The live reality |

### 6.2 Recommendation: `crystal_threads` **v2**, keyed `(org_id, user_id, survey_id, scope)`

**Retire v1 — it is a privacy defect, not a design mismatch.** `thread_key = crystal:${req.orgId}:${req.params.surveyId}` (`insights.ts:1493`, `:1512`) has no user component. **Every user in an org shares one conversation thread.** The `GET` history endpoint (`insights.ts:1492-1506`) selects on that key alone, so if that path were ever re-enabled, any org member could read any other member's Crystal conversation. It is dead today only because a hardcoded `true` keeps it dead. That is disqualifying regardless of the migration, and the retirement order matters: **delete the v1 write (`insights.ts:1463-1475`) before repointing the history endpoints**, so there is never a window where the endpoints read a table the new writer is also filling under different semantics.

v2 already has every column the feature needs: `user_id`, `scope`, `last_active_at`, `storage_expires_at`, `message_count` (`20240521000002:3-7`), `context_state`, `context_state_updated_at`, `turn_count` (`20260603000003:7-11`).

**Wiring:**
- Call `get_or_create_thread` early in `_run_skill_stream` — after `ctx = _build_ctx(inp)` and the rate check (`crystal.py:1804-1813`), before skill routing begins at `:1815` — and put the real `thread_id` on the `turn_start` frame (§1).
- `append_to_thread` for the user turn and the assistant turn.
- Pass the real `thread_id` into `TurnEvent` — kills `crystal.py:1645`, and lets us restore `thread_id NOT NULL`, reversing `20260623000009:12-14`. That reversal is the concrete proof the defect is fixed, so it belongs in the plan, at G4.
- Repoint `GET`/`DELETE /:surveyId/crystal/history` (`insights.ts:1490-1517`) off `thread_key` onto `(org_id, user_id, survey_id, scope)` with `req.userId`. **Keep both endpoints** — they are correct code over the wrong table shape. Both already sit behind `router.use(requireAuth)` (`insights.ts:320`), so there is no auth gap to fix, only a key.
- Wire the two zero-caller client methods `api.getCrystalHistory` / `api.clearCrystalHistory` (`app/src/lib/api.ts:2231-2245`) — verified zero callers outside `api.ts`. **This is the orphaned-endpoint fix the mandate asks for, and it is the seam to the SSE path:** the SSE path never touches a thread table, so the history endpoint has nothing to read. Once `_run_skill_stream` appends, `GET history` becomes the panel's rehydrate-on-mount source and `RemoteThreadListAdapter` (`ASSISTANT_UI.md:149`) can front it, which is how we skip the Assistant Cloud upsell.

**Two defects in the code we are about to wire up:**
- `get_or_create_thread(ctx, db_pool)` (`crystal.py:217`) takes a `db_pool` argument it never uses — it calls `_db._pool_conn()` internally (`:222`). Drop the parameter before it gets 20 call sites.
- `get_or_create_thread` commits explicitly (`crystal.py:264`, `:274`) while `append_to_thread` (`crystal.py:283-306`) relies on the pool context manager's implicit commit. `AsyncConnectionPool` is opened with defaults (`crystalos/lib/db.py:27`), so the implicit commit should hold — but the inconsistency means one of the two authors was unsure, and neither function has ever run against a live database. **Normalise to explicit commits and add an integration test before trusting either.** Flag for Sam: this is precisely the "no safety net" shape.

### 6.3 Resolving the `MemoryManager` L2 overlap

`get_memory_manager` **is** called in production, but only for L3 survey-fact warming: `crystal.py:1441-1444` calls `warm_from_tool_results`, and `crystalos/graphs/insights.py:5178-5179` does the same. Verified by grep, the entire L2 + org-memory half has **zero** production callers: `get_thread_context` (`memory.py:143`), `update_thread_context` (`:166`), `should_compress` (`:159`), `_compress_messages` (`:191`), `build_context_blocks` (`:258`), `build_context_injection` (`:505`), `get_org_memory` (`:365`), `write_org_memory` (`:407`), `sweep_stale_threads` (`:432`) — all definition-and-tests only. `crystalos/docs/GAPS_STATUS.md:47` states the intent plainly: *"Crystal needs to call `memory_manager.build_context_injection()` per turn (integration sprint)."* The sprint never happened.

Meanwhile `_skill_synthesis` hardcodes the fields that layer would fill (`crystal.py:1332-1341`):

```python
"org_memory_facts": [],
"context_state": { "decisions": [], "data_retrieved": {...} },
```

**The skill is told there is no memory, on every single turn.** `crystal-analyst`'s SKILL.md instructs it to *"Use the context_state to avoid repeating information from earlier in the conversation"* (`SKILL.md:37`) against a field that is always empty.

**Decision: wire L2, do not delete it — but wire only `context_state`, and only after v2 writes exist.**

- After `append_to_thread`, if `should_compress(turn_count)` (`memory.py:159`), schedule `update_thread_context` (`:166`) — fire-and-forget, since a missed compression costs context quality, not correctness.
- In `_skill_synthesis`, replace the hardcoded `context_state` (`crystal.py:1333-1341`) with the row's `context_state` when present, preserving the current `data_retrieved` sub-block so existing evals see the same shape.
- **Leave `org_memory_facts` hardcoded `[]` for now** and delete `get_org_memory`/`write_org_memory`/`_extract_and_write_org_memory` or move them behind an explicit `CRYSTAL_ORG_MEMORY_ENABLED` flag. Cross-turn org-level memory extraction is a data-retention and correctness question well outside this migration, and half-wiring it is how you get a copilot that confidently repeats last quarter's number.
- `sweep_stale_threads` (`memory.py:432`) folds into the sweeper below rather than staying a second orphan.

Net: one live implementation, one flagged-off implementation, zero dead ones.

### 6.4 The `storage_expires_at` sweeper

`storage_expires_at` has been written since 2024 (`20240521000002:6`, `NOW() + INTERVAL '90 days'`) and never read. `crystalos/scheduler.py` already has the pattern: `run_retention_job` (`:773`) gated by `ENABLE_RETENTION_JOB` (`:761`), invoked from `run_scheduler_once` (`:928`, call at `:986`).

Add to `run_retention_job`: delete `crystal_threads` rows past `storage_expires_at`, and call `MemoryManager.sweep_stale_threads` (`memory.py:432`) for the `context_state`/inactivity half. Index exists (`20260603000003:14-15`, `:18-20`). ~30 lines plus a test. **Do not ship thread persistence without the sweeper in the same release** — that is how a retention promise becomes a retention incident.

**Three conflicting retention values must be reconciled to one** (§11 item 6): `storage_expires_at` defaults to 90 days (`20240521000002:6`), `CRYSTAL_THREAD_INACTIVITY_TTL_DAYS = 7` (`crystalos/lib/constants.py:354`) resets thread contents after a week of inactivity (`crystal.py:246-259`), and `BrandContext.thread_ttl_days = 7` (`crystalos/crystal/context.py:21`) is never read by anything. A user who returns after 8 days finds an empty thread that the database still retains for another 82 days — the worst of both: no continuity benefit, full retention exposure.

### 6.5 Do not build branching

Unchanged, and it is a correctness argument, not a cost one. Every turn re-uploads its own grounding corpus from the client (`CrystalPanel.tsx:344-351`; server-merged "client wins if non-empty" at `experience.ts:719-732`). Two branches of the same question asked from two different pages were grounded on **different insight sets**, so a branch picker would present incomparable answers as alternatives to one question. The prerequisite for branching is server-side grounding, not a UI library. Supply `setMessages` to `ExternalStoreRuntime` if the runtime requires it (`ASSISTANT_UI.md:88`), but do not surface `BranchPicker`.

### 6.6 Cost

| Work | Days |
|---|---|
| Wire v2: `get_or_create_thread` + `append_to_thread` in `_run_skill_stream`; real `thread_id` on `turn_start` and `TurnEvent`; drop the unused `db_pool` param; normalise commits; integration tests | 2.0 |
| Repoint + keep the history endpoints on the v2 key; wire the two client methods | 0.75 |
| Retire v1: delete the write, leave `thread_key` nullable one release (drop at G4) | 0.5 |
| `MemoryManager` L2 `context_state` wiring; flag off / delete the org-memory half | 1.0 |
| `storage_expires_at` + `sweep_stale_threads` in `run_retention_job` + test | 0.5 |
| **Total** | **≈4.75 d** — up from my prior 3.0, because L2 and the sweeper were previously scoped as "either wire or delete" and are now specified |

---

## 7. `locale` on `CrystalInput` — gate G2

The one true prerequisite for a second locale, and it is cheap **now** and expensive later, because we are already opening `CrystalInput` for §1.

**The split, sharpened by Theo's correction.** Chrome strings can be localised client-side; model prose cannot. Theo showed the reasoning timeline is *not* the unfixable case I claimed: `CrystalPanel.tsx:2423` computes `const meta = step.tool ? TOOL_META[step.tool] : null` and the label at `:2433-2436` prefers `meta?.label`, falling back to phase-derived strings, with `step.message` only as the **third** fallback. Since the contract already carries the machine code `tool` (`crystal.py:1931-1935`), the labels are already client-ownable. I was wrong; the fix is `t()` over `TOOL_META`, which is Theo's territory.

**The genuine contract slice is exactly two things:**

1. **`observation.summary`** (`crystal.py:1941-1946`, and the bare error variant at `:1947`) — `"Found data"` or a raw tool error string, truncated to 200 chars, rendered raw at `CrystalPanel.tsx:2504-2507`. There is no machine code to key on. Replace with `{tool, status: "ok"|"empty"|"error", code, row_count?}` and let the client compose via `t()`. **0.25 d.**
2. **Six hardcoded English user-facing error sentences** across two services: `crystal.py:1808`, `:1812`, `:1992`; `main.py:1806`; `experience.ts:800`, `:828`. Replace with `{code, params}`; copy moves to `locales/en.ts`. **0.25 d.**

**Plus `locale` on `CrystalInput`** (`crystal.py:112-155`, defaulting `"en"`), threaded from Express (derived from the Clerk user or `Accept-Language`, not the raw body) into `skill_input` (`crystal.py:1317-1341`) and into the skill prompt as an instruction to answer in that language. Model prose — `answer`, `suggestions[]`, and proposal `title`/`description`/`cta_label`/`business_rationale` (`crystal.py:166-172`) — can never route through `t()`; producing it in the user's language via the prompt is the only honest target. **0.25 d for the field and the thread-through; the prompt/quality work is a separate, larger project and is explicitly not scoped here.**

Do **not** add a locale EVALS criterion in this slice — it would be a semantic criterion, hence a fourth or fifth sequential LLM judge call (§8.2), and quality-in-locale is unmeasured either way today.

**Total: 0.5 d for the contract slice, plus `locale` itself. Scoped as one PR alongside §1 because it touches the same model.**

---

## 8. Quick wins

### 8.1 `asyncio.gather` the prefetch tools — the cheapest latency win available

`crystal.py:1912` is `for tool_name in candidates:` with `await dispatch_tool(...)` inside (`:1937`). `candidates` is `PRIORITY ∩ allowed_tools`, capped at 3 (`:1910`). Three sequential Postgres round trips where one `gather` would do.

The complication is that the loop **yields SSE frames** interleaved with the awaits — `thinking` before each call (`:1931-1935`) and `observation` after (`:1941-1946`). Naive gathering destroys the reasoning timeline, which `README.md:87` forbids degrading.

Correct shape: yield all `thinking` frames up front, `gather` the dispatches, then yield `observation` frames as each completes via `asyncio.as_completed` so the timeline still fills incrementally and out-of-order completion is visible rather than hidden. The `request.is_disconnected()` check (`:1913-1918`) moves before the gather; add a `TaskGroup`-style cancel on disconnect so an abandoned turn does not keep three queries running.

**0.75 d** (up from my prior 0.5 — the frame-ordering work is real). Same treatment applies to the two sibling loops at `crystal.py:1546` and `:1571`.

### 8.2 The three sequential LLM-judge calls

`_check_evals` loops criteria sequentially (`skill_runtime.py:374-382`) calling `_eval_criterion` (`:427`), which routes non-structural criteria to an LLM judge (`:437-473`). For `crystal-analyst`: E1 is structural (*"valid json"* ∈ `STRUCTURAL_KEYWORDS`, `skill_runtime.py:53-56`); **E2 is structural too** — it matches `"non-empty"` (`:484`), which is how it became the must-pass bug in §2.4. E3 (*"2-5 sentences"*) matches no keyword. E4 (*"are specific follow-up questions"*) and E5 (*"reference actual data"*) match none. So **three sequential judge calls** run between generation and emission, each a full LLM round trip, before a single byte of answer reaches the user.

Fix: `asyncio.gather` the criteria. They are independent — each returns a float from `output` and `input_data` with no shared state. `0.5 d`. This is a prerequisite for §2.7's E6, which would otherwise make it four.

Also worth noting for whoever owns latency: E2 being "must pass" with a judge-free structural scorer is the *good* case. E4's judge failing open at `0.5` (`skill_runtime.py:471-473`) against a `>= 0.80` threshold means a single judge hiccup fails E4, adds an issue, and — if the weighted total drops below `SKILL_EVAL_PASS_THRESHOLD` — triggers a full re-synthesis. The retry is the expensive path and it is triggerable by an unrelated LLM's flakiness.

### 8.3 `debug_routing` / `debug_timing` / `store_trace` / `legacy` unreachable

`crystal_stream_endpoint` takes four query params (`main.py:1720-1723`: `debug`, `store_trace`, `legacy`). The proxy's upstream `fetch` (`experience.ts:789`) appends **no** query string, so all are permanently `False`. Consequences: `debug_routing` (`crystal.py:1893-1899`) and `debug_timing` (`:1966-1967`) never emit, `crystal_debug_traces` is never written, and the legacy ReAct path is unreachable.

Fix is one line — but see §5.5 Stage 3: **forward `debug` and `store_trace` now; forward `legacy` in a separate, later release.** `debug`/`store_trace` only add frames. `legacy` reactivates `_run_react_loop_streaming`, which is the only caller of `_build_filtered_tool_list` (`crystal.py:763`) and `_extract_action_proposals` (`:1453`), against a permission filter that has never filtered (§5.3). **0.25 d for the safe half.**

### 8.4 `ActionProposalType` in TypeScript only

Covered in §3.4 — folded into the proposal workstream, with the generated-union test also covering `viz.kind`. **Corrected count: 21 TS members, 18 dispatched, 3 writing false `failed` funnel rows.**

### 8.5 One OpenAPI contract test instead of eight edits

FastAPI serves `/openapi.json` free. A test that walks the exported paths in `app/src/lib/adminApi.ts` and `backend/src/lib/agentsClient.ts` and asserts each exists upstream costs **~1 d** and prevents recurrence; the eight path corrections fall out of it as failures to fix. Known members: `adminApi.ts:304`/`:309` → `/api/admin/dlq(/replay)` vs the real `/api/admin/crystal/dlq(/replay)` (`main.py:1926`, `:1941`); `adminApi.ts:283-292` → `PATCH .../signals/{signalId}` vs `.../signals/{signal_id}/status` (`crystalos/routers/brand_admin.py:158`); `api.ts:3286` → `POST /api/admin/crystal-support` vs the real `POST /insights/crystal-support` (`main.py:1615`), which breaks both the panel's support mode and `SupportCommandPalette.tsx`.

Aggregate severity is high for admin trust — three admin pages look built and are not. But none is on the chat path, so this is a **G2** item that must not be allowed to displace G1.

### 8.6 A `verifying` SSE frame

The eval wait (§8.2 — up to three judge calls plus a possible full re-synthesis) is currently hidden inside `synthesizing` (`crystal.py:1952`). Emitting a `verifying` frame makes the wait legible and tells the user their answer is being quality-checked, which is a differentiator we currently hide. **0.5 d**, and it should ship with §8.2 so the frame appears at the moment the wait actually gets shorter.

### 8.7 Not doing: token deltas

Declined, unchanged, and the reason is a correctness one. The answer text is not final at generation time: JSON/Pydantic validation retry re-calls (`crystalos/lib/openrouter.py:445-457`), the EVALS retry **replaces** `output_raw` entirely (`skill_runtime.py:174-180`), and a still-failing eval discards the whole skill output so a *different* LLM call produces a *different* answer (`crystal.py:1352-1359` → `:1978-1989`). `ChatModelAdapter.run()` accepts a single complete result (`ASSISTANT_UI.md:58-65`), so nothing in the migration requires deltas. Streaming the first attempt means streaming prose the quality gate may reject. Do §8.1, §8.2 and §8.6 instead — they cut the latency that actually exists.

---

## 9. Cross-checks

### 9.1 With Nadia — the `generative-ui` contract and proposal rendering

**What I am committing to give her:**

1. A **neutral versioned `viz` payload on the `answer` frame**, not assistant-ui's part shape (§2.6 rule 1). Her adapter translates `viz[]` → `{type:"generative-ui", spec:{root:{component, props, children}}}`. This is deliberate isolation, and it is the `unstable_`-containment layer `README.md:90` asks for, placed at the seam where it costs least.
2. A **closed `kind` enum**, generated into TypeScript by the same parity test as `ActionProposalType` (§3.4). Her registry maps `kind → component` and the compiler proves the mapping is total. **`GenerativeUIRenderError` on an unknown component name becomes unreachable by construction** (`README.md:119`). I own the enum; she owns the registry; the test owns the join.
3. **Materialised data with a `grounding` block**, never model-authored values (§2.3). She can render a chart without needing to know whether a model or a rule chose it, and she can surface provenance the same way she surfaces citations.
4. `InsightDocumentCard.tsx` **kept and registered** under `kind: "report_card"` (§2.5) — a working styled component in her registry on day one, and proof the registry is not chart-specific.
5. Proposals as `{tool_call_id, tool_name, args, status:"requires-action"}` **inside the terminal `answer` frame** (§3.2), so `ToolCallMessagePartComponent` (`ASSISTANT_UI.md:116-128`) is the render target and `addResult` (`:124`) is the confirm callback.

**What I need from her, and what I will change if her answer differs:**

- **Does a `viz[]` array on the terminal frame convert cleanly into multiple message parts inside one `ThreadMessageLike`, in a fixed order relative to the text part?** If parts must be interleaved with prose rather than appended, I need a position hint on each spec (`after_paragraph: int`) and that changes the skill prompt. Cheap now, a re-prompt later.
- **Does `ExternalStoreRuntime`'s `convertMessage` tolerate a tool part with `status:"requires-action"` that the runtime did not itself create?** My design assumes yes. If the runtime resists a part it did not mint — my prior §6.1 question, still open — then the fold-into-answer-frame change is necessary but insufficient, and the honest fallback is that proposals render as a custom message part rather than a tool part. That is a smaller win, not a blocker, and it costs me nothing extra because the emitted shape is identical either way. **I have deliberately made this her decision reversible from my side.**
- **Registry allowlist sign-off.** I propose the initial `kind` set `line | bar | stacked_bar | donut | sparkline | kpi | table | report_card`. She should cut anything she is not prepared to build well; a `kind` with no component is worse than no `kind`, and the server enum is the harder thing to shrink later.

**Where we may still disagree:** if she wants CrystalOS to emit assistant-ui's part shape directly to save adapter LOC, I will decline, and the disagreement should go to synthesis verbatim rather than be reconciled. Saving adapter lines by hard-coding a pre-1.0 library's field names into the contract that also serves Slack, Teams, WhatsApp and email (`message_processor.py:163-167`) is the trade I am least willing to make.

### 9.2 With Sam — funnel integrity and message-identity rollout ordering

**Rollout order, and it is not negotiable:**

1. **`turn_id` on the wire first, additively.** The `turn_start` frame and the injected `turn_id` are ignorable by the current panel — an unknown `type` falls through the `if/else` chain at `CrystalPanel.tsx:419-477` silently, and the extra key is inert on known frames. So identity can ship and be verified in production **while the old panel is still the default**. That is the single most valuable sequencing property in this plan: it de-risks G1 before any UI moves.
2. **Then `emitted` writes, in shadow mode** — new columns populated, old unique index still authoritative (§4.3). One week. This is where Sam gets the collision numbers.
3. **Then flip the upsert key.** Backend-only, one file, revertible by redeploy.
4. **Then the panel flag.** Never in the same release as step 3 — if the funnel moves, we must know whether the cause was the key or the panel.

**The gate assertions I want Sam to own** (not "the rate is unchanged" — it will change, and it should, §4.3):

- Every proposal rendered in either panel has exactly one `crystal_action_proposals` row with `identity_scheme='uuid'`.
- Every such row's `turn_id` joins to a `crystal_turn_events` row. This is the join that has never worked and is the whole point of §1.
- No row's `status` ever moves backwards down the lifecycle rank `emitted < accepted < {succeeded, failed}` / `emitted < dismissed`.
- `emitted` count ≥ `accepted` + `dismissed` count, per org per day. A violation means a dropped denominator write (§4.2 rule 1).
- Zero rows with `survey_id = 'global'` after the scope fix.
- Feedback: a `POST /api/crystal/feedback` with a `turn_event_id` from the current turn succeeds without an FK violation. This pins the §1.3 race.

**Untested surfaces I am creating, flagged deliberately.** `get_or_create_thread` and `append_to_thread` (`crystal.py:217-306`) have **never run against a live database** and disagree with each other about commits (§6.2). `_materialise_viz` is new code on the answer path. `proposal_publisher` is a new awaited write on the answer path with a 250 ms timeout. All three want integration tests, not just unit tests — this is exactly the "which production behaviours have no safety net" shape from `TEAM.md:103`.

**One flag-scope request.** `CRYSTAL_VIZ_ENABLED` should be **per-org and server-side**, not a client flag. A chart is a claim about an org's data; if we need to kill it, we need to kill it at the emitter, not hope the client honours a flag. Same for `CRYSTAL_ROLE_PASSTHROUGH` (§5.5).

---

## 10. Phased plan

All days are CrystalOS + backend engineer-days. Frontend cost is Nadia's and Theo's.

### G0 — Spike · 4.75 d

| Work | Days | § |
|---|---|---|
| `_eval_structural` non-empty fix + regression tests (**prerequisite for everything in §2**) | 0.5 | 2.4 |
| `turn_id`/`thread_id`/`locale` on `CrystalInput`; `event_stream` wrapper; `turn_start` frame; SSE `id:` line | 1.5 | 1.3 |
| Express: mint both ids, response headers, `agentBody` pass-through | 0.5 | 1.3 |
| `VizSpec` models + `viz` on `CrystalOutput` + explicit copy in `_normalize_skill_output` | 0.75 | 2.4 |
| `_derive_viz` Tier 0 (`get_metric_history`) + `_materialise_viz` + whitelist + `grounding` block, behind `CRYSTAL_VIZ_ENABLED` | 1.0 | 2.3 |
| `asyncio.gather` prefetch with preserved frame ordering | 0.5 (partial) | 8.1 |

**Prerequisites:** none. **Rollback:** every item is additive and flag-gated; the current panel ignores unknown frames and unknown keys (`CrystalPanel.tsx:419-477`), so G0 can ship to production with the old panel default and be reverted by a flag.
**Risk carried:** the `_eval_structural` fix touches the gate that decides whether *every* Crystal answer ships. If the field-name parser is wrong, turns fail closed and fall through to `_run_crystal` — degraded answers, not errors, which is the hard-to-detect direction. Mitigation: ship it alone, first, with a week of eval-pass-rate monitoring before anything else in G0 lands.

### G1 — Contract · 9.5 d

| Work | Days | § |
|---|---|---|
| Telemetry: explicit `id` on INSERT + `ON CONFLICT`; fix `create_task(None)`; move scheduling ahead of the answer frame | 0.75 | 1.2, 1.3 |
| Express `POST /api/crystal/feedback` proxy route + retry-on-`23503` | 0.5 | 1.3 |
| Frontend: adopt server ids at 5 sites, `local:` prefix convention | 0.5 | 1.3 |
| Cross-seam identity contract tests (with Sam) | 1.0 | 1.5 |
| Proposals: `_mint_proposal` (`proposal_id`, `tool_call_id`, `turn_id`, `status`, nested `args`) | 1.0 | 3.2 |
| Fold `action_proposals` into the `answer` frame; delete the separate event, both paths | 0.5 | 3.2 |
| `StrEnum` + generated TS union + parity test (covers `viz.kind`) | 1.0 | 3.4 |
| Handle/delete `workflow`/`template`/`export_insights`; stop false `failed` writes | 0.5 | 3.4 |
| Novu non-interactive test; legacy-path shape update | 0.5 | 3.3 |
| Migration `011` + audit queries | 0.5 | 4.2 |
| Backend upsert: new key, monotonic status guard, `scope` fix, tests | 1.0 | 4.2 |
| `proposal_publisher.py` + awaited `emitted` write inside the eval gate | 0.75 | 4.2 |
| Shadow-week instrumentation + measurement writeup | 0.25 | 4.3 |
| `user_role` Stage 1: strip from spread, derive server-side, keep pinned, reconcile the vocabulary | 0.5 | 5.5 |

**Prerequisites:** G0's identity slice. **Rollback:** new columns additive; old unique index retained one release; upsert key revertible by redeploying one file; `CRYSTAL_ROLE_PASSTHROUGH` stays `false`.
**Risk carried:** the `emitted` write is a **new awaited database write on the answer path**. A slow Postgres now delays every answer by up to the 250 ms timeout. Mitigation: the timeout is the mitigation, plus a p99 alert on the write; if it proves hot, move it to a bounded queue rather than making it fire-and-forget (§4.2 rule 1 explains why fire-and-forget is not acceptable here).
**Second risk:** the funnel metric will visibly move (§4.3), and it will look like a regression to anyone who has not read §4.3.

### G2 — Parity · 3.25 d

| Work | Days | § |
|---|---|---|
| Machine-coded `observation.summary` + 6 error `{code, params}` | 0.5 | 7 |
| `locale` threaded into `skill_input` and the skill prompt | 0.25 | 7 |
| Forward `debug` + `store_trace` query params (**not `legacy`**) | 0.25 | 8.3 |
| `verifying` SSE frame | 0.5 | 8.6 |
| Parallelise the EVALS criteria loop | 0.5 | 8.2 |
| `user_role` Stage 2 — the audit; repair `TOOL_PERMISSION_MAP`; registry-parity test | 1.0 | 5.5 |
| OpenAPI contract test + the 8 path corrections | 1.0 | 8.5 |
| Remainder of `asyncio.gather` (sibling loops at `crystal.py:1546`, `:1571`) | 0.25 | 8.1 |

**Prerequisites:** G1. **Rollback:** all independent, individually revertible. The `observation.summary` reshape is the only breaking wire change; ship it with the old key retained for one release so both panels render.
**Risk carried:** parallelising EVALS changes the *timing* of judge calls against a rate-limited model. If concurrency triggers 429s, judges fail open at `0.5` (`skill_runtime.py:471-473`) and eval pass rates move for a reason unrelated to quality. Add a small semaphore and monitor the pass rate across the change.

### G3 — Gains · 7.25 d

| Work | Days | § |
|---|---|---|
| Thread persistence v2: wire, real `thread_id`, drop unused param, normalise commits, integration tests | 2.0 | 6.2 |
| History endpoints repointed to the v2 key; wire the 2 client methods | 0.75 | 6.2 |
| Retire the v1 write | 0.5 | 6.2 |
| `MemoryManager` L2 `context_state` wiring; flag off the org-memory half | 1.0 | 6.3 |
| `storage_expires_at` + `sweep_stale_threads` in `run_retention_job` | 0.5 | 6.4 |
| Tier 0 widening: topics, segments, drivers, `report_card` subsume; delete `documents[]` client branch | 1.0 | 2.5 |
| Tier 1: model-referenced `viz` — SKILL.md schema, prompt section, E6, resolution + drop-path tests | 1.5 | 2.7 |

**Prerequisites:** G1 identity (thread work needs `thread_id` on the frame); G2's parallel EVALS (before E6 adds a judge call).
**Rollback:** thread writes are additive — the panel works without rehydration, so persistence can be disabled without breaking chat. Tier 1 is gated by the same `CRYSTAL_VIZ_ENABLED` flag as Tier 0, plus `CRYSTAL_VIZ_TIER1`.
**Risk carried:** Tier 1 is the only place in this plan where a model influences what gets rendered as data. The reference-only design (§2.3) makes fabricated data points a `ValidationError` rather than a chart, but it cannot prevent a *correctly grounded, badly chosen* chart — a real series that does not support the answer's claim. E6 addresses that and E6 is a fallible LLM judge. **Accept this risk explicitly: the failure mode of Tier 1 is an irrelevant chart, not a false one.** That is the bound the design buys, and it is the right bound.
**Second risk:** `MemoryManager` L2 changes what the skill sees on every turn (`crystal.py:1332-1341`). `crystal-analyst`'s evals have never run against a populated `context_state`. Run the eval suite against real compressed states before enabling.

### G4 — Cutover · 2.0 d

| Work | Days | § |
|---|---|---|
| Restore `crystal_turn_events.thread_id NOT NULL` — reverse `20260623000009:12-14` | 0.25 | 1.4, 6.2 |
| Drop `crystal_threads.thread_key` and the v1 unique constraint | 0.25 | 6.2 |
| Drop `crystal_action_proposals.proposal_key` + old index; `VALIDATE CONSTRAINT` on the status CHECK | 0.5 | 4.2 |
| Delete the `action_proposals` SSE-event handling from the frontend | 0.25 | 3.2 |
| `user_role` Stage 3 — flip `CRYSTAL_ROLE_PASSTHROUGH`, staged per org (**gated on the G2 audit**) | 0.25 | 5.5 |
| Forward `legacy` query param — **separate release from the line above** | 0.25 | 5.5, 8.3 |
| Publish the funnel discontinuity note + frozen v1 series | 0.25 | 4.3 |

**Prerequisites:** two clean weeks post-G3; the §5.5 Stage 2 audit passed.
**Rollback:** the column drops are the first irreversible steps in this plan. Take a snapshot; do them last; do them one release apart.
**Risk carried:** flipping `CRYSTAL_ROLE_PASSTHROUGH` and forwarding `legacy` in the same release reactivates the ReAct path against a permission filter that has never filtered (§5.3). Explicitly forbidden above; the risk is that someone bundles them for convenience during a cutover push. Name it in the release checklist.

---

## 11. Needs a product decision, not an engineering one

1. **Does Tier 1 (model-referenced) generative UI ship, or is Tier 0 (deterministic) sufficient?** Tier 1 is where "agent-specified" actually lives and it is the stated goal (`README.md:14`, `:89`). Tier 0 delivers charts with zero model risk and zero token cost. Delta: **2.5 d** and the residual risk in §2.3/G3. My recommendation is ship both, Tier 0 first — but "agent-specified charts" being the *goal* rather than "charts" being the goal is a product statement I should not make on my own.
2. **`viz` schema-version deprecation window.** How long must the frontend registry resolve version N−1? I propose two versions. This is a decision about how long persisted threads must render, which is a retention question wearing an engineering hat.
3. **PII policy for the copilot (§5.5 Stage 2).** `get_contact_identity` returns real names and emails to `admin`/`brand_admin` (`tools.py:2039-2052`). Un-pinning `user_role` and adding that tool to a skill's `allowed-tools` would let Crystal name individual respondents in chat. That is a defensible product for a CX case-management workflow and indefensible for an anonymous survey. **Nobody has decided which we are**, and the current answer is accidental (`viewer` because the frontend omits a field). This needs an owner before Stage 3.
4. **Is a visible step change in the reported proposal accept rate acceptable?** It is unavoidable (§4.3) and the direction is down, because the denominator becomes correct. Whoever reports that number needs to agree in advance, or the correct fix will be read as a regression and rolled back.
5. **G3 ordering.** `TEAM.md:128` names the gap: no PM, no user research, so nobody can sequence markdown vs a11y vs charts vs persistence by user value. I have sequenced G3 by **dependency** — thread persistence before Tier 1 charts, because a chart the user loses on reload is worth less than one they keep. That is an engineering guess dressed as a rationale and should be overridden by anyone with actual user signal.
6. **One thread-retention number.** Three exist and they conflict: `storage_expires_at` = 90 days (`20240521000002:6`), `CRYSTAL_THREAD_INACTIVITY_TTL_DAYS` = 7 (`constants.py:354`), `BrandContext.thread_ttl_days` = 7 (`context.py:21`, never read). A user returning after 8 days finds an empty thread that we still retain for 82 more — no continuity benefit, full retention exposure. Needs one answer plus a privacy review, **before** the sweeper ships, because the sweeper is what makes the number real.
7. **Org-level cross-turn memory** (`org_memory_facts`, §6.3). I recommend flagging it off rather than wiring it. Enabling it means Crystal asserts facts learned in a previous session, which is a correctness and data-retention posture, not a feature toggle.

---

## 12. Corrections to my own prior assessment

Recorded explicitly, per house rule 5 (`TEAM.md:24`). Every item below was verified in this pass.

| # | Prior claim (`ASSESSMENT_CRYSTALOS.md`) | Correction |
|---|---|---|
| 1 | Migration order is the only reason feedback is uncallable | **Two reasons.** There is also no Express proxy route for `POST /api/crystal/feedback`, and the upstream requires `require_internal_key` (`feedback.py:61`), so a browser could never reach it even with an id. Not in any prior document. |
| 2 | Telemetry fires correctly, just late | **It raises on every turn.** `crystal.py:1659` wraps a synchronous `def` (`turn_publisher.py:112`) in `asyncio.create_task`, producing a `TypeError` swallowed by `except Exception: pass` (`:1660-1661`). The write happens only because the inner call is evaluated first. §1.2 |
| 3 | `user_role` never reaches CrystalOS | **It does, if the client sends it.** `agentBody = { ...body, … }` (`experience.ts:706`, `:733`) spreads the raw body and `main.py:1743-1745` whitelist-accepts it. A live self-assignment path, currently inert. §5.2 |
| 4 | `user_role` gates which tools Crystal may use per request | **Effectively it gates one thing.** `TOOL_PERMISSION_MAP` (`crystal.py:659-664`) names four tools that exist nowhere in CrystalOS, so `_build_filtered_tool_list` (`:711-730`) filters nothing for any role — and it is only called from the unreachable ReAct prompt (`:763`). The sole live check is `data:pii` inside `execute_get_contact_identity` (`tools.py:2039`). §5.3 |
| 5 | `crystal-analyst`'s `allowed-tools` having zero action tools generalises to all skills | **`workflow-analyst/SKILL.md:38` lists `propose_workflow`.** Still unreachable in the stream path (`PRIORITY ∩ allowed`, `crystal.py:1905-1910`), so the conclusion holds and the premise was overstated. §3.1 |
| 6 | `ActionProposalType` has 25 members | **21** (`app/src/types/index.ts:782-807`). 18 dispatched. §3.4 |
| 7 | Drifted types "fall through to `default`" harmlessly | **`default` calls `track('failed', …)`** (`CrystalPanel.tsx:1009-1011`), so type drift writes false `failed` rows into the outcome funnel. A data-integrity defect, not a dead branch. §3.4 |
| 8 | `answer.documents[]` is an unshipped feature; emit it (~0.5 d) | **Subsume it into `viz` and keep `InsightDocumentCard`** as the `report_card` registry component. Same cost, plus versioning, provenance, and one channel instead of two. §2.5 |
| 9 | `MiniNPSChart`'s removal might indicate product judgment against charts | **It does not.** `CrystalPanel.tsx:2543` — removed because it was *"hardcoded fake data tied to buildDemoResponse"*, alongside the rest of the mock path. `README.md:127`'s concern is retired for that precedent. §2.1 |
| 10 | The proposal funnel's problem is the slug key | **Also the unconditional `SET status = EXCLUDED.status`** (`insights.ts:2319`), which has no lifecycle guard. A new key prevents cross-proposal collisions; only a monotonic status guard prevents `dismissed` overwriting `succeeded`. And `survey_id` is the literal `'global'` for every org-scope turn (`CrystalPanel.tsx:761`). §4.1, §4.2 |
| 11 | The eval gate would validate a new `viz` channel safely | **Adding any optional output field breaks a must-pass criterion.** `_eval_structural`'s `non-empty` branch scores *every* output key (`skill_runtime.py:484-487`) and E2 is `must pass` (`crystal-analyst/EVALS.md`), so `action_proposals: []` — which SKILL.md explicitly offers (`SKILL.md:82-84`) — fails the gate today. Hard prerequisite. §2.4 |
| 12 | Grounding could be asserted as an EVALS criterion | **It cannot.** `_eval_structural` defaults to a soft pass of `0.8` (`skill_runtime.py:517`) for unmatched criteria, and the LLM judge fails open at `0.5` (`:471-473`). Grounding must be deterministic Python or nothing — which is the argument for reference-only materialisation. §2.3 |
| 13 | Thread persistence is ~3 d | **~4.75 d**, once `MemoryManager` L2 and the sweeper are specified rather than deferred, and once the two defects in `get_or_create_thread`/`append_to_thread` are accounted for. §6.6 |
| 14 | The reasoning-timeline i18n is unfixable client-side | **Wrong, per Theo.** `CrystalPanel.tsx:2423` keys on the machine code `tool`; `step.message` is only the third fallback (`:2433-2436`). The genuine contract slice is `observation.summary` (`:2504-2507`) plus six error strings. §7 |
| 15 | The migration makes the closed loop weaker (opportunity cost) | **Stronger.** The funnel repair is inside gate G1 (`README.md:100`), so it cannot be skipped without failing a gate. The opportunity-cost argument does not survive that. §3.5 |
