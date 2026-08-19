# Xperiq — Agents Service (CrystalOS)

## What this is
Python FastAPI service that powers all AI pipelines and Crystal Intelligence.
Runs alongside the Node.js backend (deployed separately to Fly.io).
The backend calls this service via `agentsClient.js` using `AGENTS_INTERNAL_KEY` for auth.

## Stack
- Python 3.11+ + FastAPI + uvicorn
- LangGraph — stateful multi-node AI pipelines
- asyncpg / psycopg — Postgres async driver
- ioredis (Python: `redis.asyncio`) — Redis streams + rate limiting
- OpenRouter — LLM gateway (GPT-4o, Claude, Llama)
- Prometheus client — metrics at `/metrics`

## Directory structure
```
agents/         # Package root
  agents/       # Individual AI agents (creator, copilot, refiner, etc.)
  consumers/    # Redis stream consumer (response_stream.py) — progressive tier triggers
  crystal/      # Crystal Intelligence platform
    context.py    # CrystalContext frozen dataclass
    registry.py   # 58 tool definitions with JSON Schema (re-derive: count `"name":` in TOOL_REGISTRY)
    tools.py      # executor functions, one per tool + dispatch_tool
  graphs/       # LangGraph pipelines
    insights.py   # Main insight generation pipeline (13 nodes as of Phase 0.5)
    nodes/        # Shared node logic (context, route_specialists)
  lib/          # Shared utilities
    db.py         # Postgres pool + helper functions
    constants.py  # Central config (all tunable values live here)
    checkpoint_store.py  # Crystal checkpoint blobs (local FS or GCS)
    topic_signals.py     # Full topic signal computation
    topic_registry.py    # Survey topic centroid registry
    security.py          # check_survey_access, require_internal_key
    openrouter.py        # LLM API client with retry
    metrics.py           # Prometheus counters + histograms
    event_publisher.py   # SSE run event publisher
    trace_context.py     # Async trace context (run_id/org_id per request)
  schemas/      # Pydantic models (InsightState, InsightRecord, etc.)
  specialists/  # 7 domain specialist agents (NPS, CES, CSAT, etc.)
  tools/        # ML utilities (embeddings, clustering, sentiment, delta)
main.py         # FastAPI app entry — mounts all routers
scheduler.py    # Background jobs: zombie sweep + org aggregation
```

## Key architectural patterns

### Crystal vs Copilot — roles & the action-proposal boundary (standing convention)

Two distinct AI assistants, two phases of the workflow. They share the same
skill-framework engine (SKILL.md + EVALS + SkillRuntime + legacy fallback) but
play opposite roles:

| | **Crystal** | **Copilot** |
|---|---|---|
| Role | Understand & **recommend** | **Act & edit** |
| Phase | After data is collected (analysis) | Authoring / editing the survey |
| Operates on | insights, topics, metrics, verbatims | survey questions |
| State | **read-only** — never mutates | writes (validated, eval-gated) |
| Entry | `POST /api/insights/:surveyId/crystal` → `_run_skill_stream` | `POST /orchestrate/{run_id}/refine` → `copilot_agent` (`copilot-analyst` skill) |

**The boundary that keeps this safe:**

> **Crystal proposes, Copilot / endpoints execute.** Crystal never mutates state
> directly. Anything that changes data is surfaced as an *action proposal* that
> the user explicitly confirms; the frontend then calls the right endpoint.

**Action proposals** (`ActionProposal` in `agents/crystal.py`, dispatched in
`app/src/components/CrystalPanel.tsx` ~line 501). Crystal may recommend any of
these; confirming the card executes it:

| Recommendation | `type` | Executes via | Wired? |
|---|---|---|---|
| Add a survey | `create_survey` | `api.startRun()` | ✅ |
| Add / edit questions | `edit_survey` / `edit_survey_questions` | `api.copilotRefine()` (→ **Copilot**) | ✅ |
| Add a workflow | `create_workflow` | `api.createWorkflow()` | ✅ |
| Distribute | `distribute` | distribution tab | ✅ |
| Re-run insights | `schedule_rerun` | `api.triggerInsightGeneration()` | ✅ |
| Add an alert | `create_alert` | `api.createAlertRule()` (tool: `propose_alert`) | ✅ |

**Two sources emit proposals**, both normalised to the same shape:
1. **Default (skill) path** — the `crystal-analyst` SKILL.md output schema includes
   an optional `action_proposals[]`; the skill emits them when the data justifies a
   next step. Surfaced via `_normalize_skill_output()`.
2. **Legacy/agentic path** — the `propose_*` action tools (`crystal/tools.py`,
   registered in `ACTION_TOOL_NAMES`). Surfaced via `_extract_action_proposals()`.

Tool/skill proposals (which may carry `proposal_type` and omit `id`) are normalised
to the frontend `ActionProposal` shape — `type` + slug `id` + defaults — by
`_normalize_proposal()` in `agents/crystal.py`. Add the alias there if a tool's
`proposal_type` differs from the frontend handler name (e.g. `workflow` →
`create_workflow`, `alert` → `create_alert`).

Going forward: new "act/edit" capabilities (workflow editing, distribution,
alerts, settings) belong to **Copilot** and should each be a **separate skill**
with its own EVALS gate, routed the same way. New "explain/recommend" capability
belongs to **Crystal** and emits an action proposal rather than executing.

### Survey skills are skill-first with legacy fallback
`survey-creator` and `copilot-analyst` run via `registry.execute()` inside
`agents/creator.py` / `agents/copilot.py`. On skill failure (not registered,
eval fail, or output-mapping error) they fall back to the legacy `call_agent`
path — output is identical downstream (all ID-fix / bias / logic guards still
run). The skill↔`Question`-schema mapping lives in `lib/skill_survey_adapter.py`.
`survey-qc` remains on the legacy `quality_control_agent` (coupled to the
creation graph's revision loop).

### Crystal Intelligence (skill-first streaming — default)
- Entry: `POST /api/insights/:surveyId/crystal` → `crystal_stream_endpoint` (`main.py`) → `_run_skill_stream` (`agents/crystal.py`)
- Flow: **semantic-route** to the best skill (`skill_registry.find`, top_k=1) → directly call up to 3 of that skill's allowed context tools (no LLM tool selection) → synthesize via `SkillRuntime` (`_skill_synthesis`) → emit SSE `answer` + `action_proposals`
- **Fallback chain:** skill synthesis returns None (no match / eval fail / normalize fail) → single-shot `_run_crystal`; if the stream throws before the first event → `_run_crystal` once more (`main.py`)
- **Legacy:** `?legacy=true` (admin/brand_admin only) runs `_run_react_loop_streaming` — the old LLM-driven ReAct tool loop, preserved for admin debug. `?debug=true` (admin) emits `debug_routing`/`debug_timing` events
- Semantic routing is live because the lifespan calls `await _skill_reg.warm_router()` at startup (pre-embeds skill descriptions); falls back to difflib `find_sync()` if not warmed
- `TOOL_REGISTRY` (`crystal/registry.py`) has **58** tool definitions (re-derive: count `"name":` in `TOOL_REGISTRY`); executors + `dispatch_tool` in `crystal/tools.py`. Phase 6 added the Insight Pipeline v2 read tools (`get_checkpoint_chain`, `get_insight_settings`, `get_insight_report`, `get_insight_trail`, `get_checkpoint_detail`, `compare_checkpoints`) and three report action proposals (`propose_manual_insight_run` → `trigger_manual_insight_run`, `propose_view_report` → `view_report`, `propose_generate_intelligence_report` → `generate_intelligence_report`). `get_insight_report` output carries `render_hint='document'` so the frontend renders an `InsightDocumentCard`.
- **Tag Report tools** (`docs/tag-report/DESIGN.md`, scope `"tag"`) — read-only tools for the conversational surface on top of `graphs/tag_report.py`'s cross-survey rollup: `list_tags` (resolve a tag by name → `tag_id`, scope `"both"`), `get_tag_report` (latest or specific `run_id`'s trust-weighted per-metric findings, `render_hint='document'`), `get_tag_report_trail` (run history for a tag). Two action proposals: `propose_view_tag_report` → `view_tag_report`, `propose_generate_tag_report` → `generate_tag_report`. Every query re-validates the caller-supplied `tag_id` against `ctx.org_id` before reading any other table (`_load_org_tag`). `get_tools_for_scope("tag")` also includes `"group"`-scoped tools (`get_group_surveys`/`get_group_metrics`/`get_group_topics`/`analyze_group_coverage`) since a tag is a survey group. Routed via the `tag-analyst` skill; `CrystalContext.tag_ids` is populated from the request body's `scope: 'tag'` + `tag_id` (see `crystal_stream_endpoint` in `main.py` and `_build_ctx` in `agents/crystal.py`), and `_routing_hint_for_scope` nudges semantic skill routing toward `tag-analyst` for tag-scoped queries since `skill_registry.find` takes free text only, no scope parameter.
- Thread continuity: `crystal_threads` by `(survey_id, org_id)`, 7-day TTL. Rate limit: 10 req/org/min (Redis)

### `ToolDispatcher` vs. `dispatch_tool` (standing decision)
`lib/tool_dispatcher.py`'s `ToolDispatcher` is fully built, tested, and initialized at
startup (`main.py`'s lifespan) — but it is **not called anywhere in production code
today**. `crystal/tools.py`'s `TOOL_REGISTRY`/`dispatch_tool` is the actual live
tool-dispatch path for Crystal's existing ~60 tools, and stays frozen there — not
migrated, not removed. Going forward: `ToolDispatcher` is the documented home for any
**new** tool-shaped capability (its manifest-driven, importlib-resolved design is a
better fit for tools that don't need to live inline in `crystal/tools.py`); the existing
tools keep using `dispatch_tool` as their stable surface. Both guarantee the same
error contract — always return a dict, never raise, `{"error": str(exc), "tool":
tool_name}` on executor failure.

### Crystal action proposals & telemetry
- Two emitters, one shape: skill path (`action_proposals[]` in skill output → `_normalize_skill_output`) and tool path (`propose_*` tools in `ACTION_TOOL_NAMES` → `_extract_action_proposals`). Both pass through `_normalize_proposal` (maps `_PROPOSAL_TYPE_ALIASES`, fills slug `id`, defaults priority/`requires_confirmation`). See the "Crystal vs Copilot" table above.
- `_fire_telemetry` (end of both stream paths) fires two fire-and-forget tasks: `turn_publisher.publish_turn_event` (TurnEvent: tools, eval_score, latency, skill_name, quality signal, `crystalos_version`, `tools_called` incl. `args`, real `tool_errors`) and `feedback_detector.detect_and_route_signal` + `persist_signal` (product-signal detection).
- `applied_filters` (`AppliedFilter` in `agents/crystal.py`) — a per-turn transparency object built by `build_applied_filters(tool_results)`, normalizing every tool call's arguments (survey/tag/checkpoint/date-range/segment/metric/topic/sentiment/layer/lane/query/entity/benchmark) into one flat, deduped list surfaced on `CrystalOutput` and every SSE `answer` event/REST response — "what did Crystal actually search," independent of the citations shown. Wired at all 4 `CrystalOutput`-construction sites (alongside `viz`); Node backend forwards it through `experience.ts`'s `crystalHandler` and `insights.ts`'s pluck-lists the same way `viz` is forwarded. Frontend: `AppliedFiltersDisclosure` (a component in `CrystalPanel.tsx`, alongside `CrystalThinkingBubble`/`ActionProposalCard`).

### SkillRuntime quality gate
`lib/skill_runtime.py` `execute()` runs EVALS.md (hybrid structural + LLM-judge), gated by `SKILL_EVAL_PASS_THRESHOLD`; retries once on failure with failure context; skills with no EVALS.md get a baseline output gate (not a blind pass); high-scoring runs are written to the example bank. Authoring details in `SKILLS.md`.

- **EVALS.md must be a markdown pipe-table** (`| E# | criterion | weight | threshold |`) — `_parse_evals_md` only extracts lines starting with `|`; a prose/bullet-format EVALS.md silently parses to zero criteria and falls through to the baseline gate (fixed 2026-08 for `gap-analyst`/`platform-gap-tracker`/`xm-market-researcher`, one of which had an unenforced SOC2/HIPAA/FedRAMP must-pass safety rule as a result — always verify a new/edited EVALS.md actually parses non-empty).
- **Two deterministic structural checks beyond `STRUCTURAL_KEYWORDS`**: an "N-M entries with fields X, Y, Z" checker and an "is one of: a, b, c" enum-membership checker, both regex-matched directly off the criterion's own description text in `_eval_structural` (which now also receives `input_data`, previously silently discarded). A criterion whose text doesn't match either regex falls through unchanged to the existing keyword/LLM-judge path.
- **`SKILL_CRITERION_VALIDATORS`** (`lib/skill_validators.py`) — a `dict[(skill_name, criterion_id), Callable[[input_data, output], float]]` registry, checked in `_eval_criterion` before the generic structural/LLM dispatch, for criteria that need a bespoke deterministic check tied to one specific skill (e.g. `workflow-analyst` E2's registry-membership grounding, which reads `input_data["survey_facts"]["workflow_registry"]` — never `tool_results`, which never carries it). A validator's score flows into the existing must-pass/retry machinery exactly like any other criterion score — no new control flow.
- **`_OUTPUT_TRANSFORMS`** — an ordered `list[Callable[[dict], dict]]` + `register_output_transform` decorator, run once after the eval/retry loop resolves and before the example-bank write. Each transform is fail-open (a raising transform is logged and skipped, never propagated). `pii_scrubber.scrub_dict` is registered as the first transform, so PII is scrubbed from a skill's output before it can ever reach `skill_examples`.

### BrandContext / permissions (`crystal/context.py`)
`BrandContext` carries brand persona + `permitted_features`/`restricted_features` allowlist + per-brand limits; `ROLE_PERMISSIONS` resolved via `_resolve_permissions` (role defaults ∩ brand contract) gates which tools Crystal may use per request.

### Insight Pipeline (LangGraph)
- Entry: `run_insight_generation(survey_id, org_id, run_id, trigger, *, profile=None, window_start=None, window_end=None, parent_checkpoint_id=None, config_override=None, actor=None)` in `graphs/insights.py`
- 17 nodes (Phase 2/3+): **resolve_context** → ingest → context → route_specialists → embed → metrics → extract_texts → absa → cluster → topics → **delta_compute** → narrate → report_agent → merge_tracks → verify → evaluate → publish
  - `resolve_context` (Phase 2, entry point) — loads effective settings (3-level COALESCE merge via `lib/insight_settings.load_insight_settings`), resolves parent checkpoint chain (`walk_parent_chain`, reads `insight_checkpoints_v2` with fallback to `survey_insight_checkpoints`), sets watermark + `new_response_ids` (automated, `submitted_at > watermark`) or window+`sample_ids` (manual/refresh via `tools/sampling`), computes `config_hash`, routes `automated_insights_enabled`/`automated_report_generation_enabled`, and can `skip_run` (below threshold / disabled / empty window)
  - `delta_compute` (Phase 0.5/2) — `delta_from_prior` + `meaningful_delta`; Phase 2 adds share-weighted `compute_topic_lifecycle` (emerged/growing/stable/declining/resolved + `fingerprint_changed`) when parent topic share data exists
- **Run profiles** (04 §1): `automated_incremental` (default; stream/scheduler/milestone) · `refresh` · `manual_expert` · `manual_quick`. `profile` derives from `trigger` when omitted (backward compatible — legacy `trigger='manual'` stays automated + `force_regenerate`)
- **publish** routes to `node_publish_manual` for manual modes (INSERT `insight_reports` generating→ready, blob + citations_manifest, `insight_checkpoints_v2` lane='manual', **no supersede** of automated insights). Automated dual-writes `insight_checkpoints_v2` (lane='automated', `parent_checkpoint_id` + `lineage_json`) alongside the legacy `survey_insight_checkpoints` write, gated by `INSIGHT_CHECKPOINTS_V2_ENABLED` (default True)
- **Credits**: `lib/insight_settings.credit_preflight` reads org balance for the automated silent-skip decision; **the Node backend owns debiting** (single ledger writer). Manual/refresh raise `InsufficientCreditsError` → HTTP 402
- `force_regenerate=True` for `trigger='manual'` + refresh + manual modes, `False` for schedule/stream
- Heartbeat updates `agent_runs.last_heartbeat_at`; zombie sweep reaps stale runs
- Checkpoint blob written to `checkpoint_store` at publish (legacy schema_version=1; manual/v2 blobs schema_version=2)

### Manual / refresh HTTP entry (Phase 3)
- `POST /insights/runs` (`main.py`, secured by `require_internal_key` / `X-Internal-Key`) — the Node backend calls this for manual + refresh runs. Body: `{ survey_id, org_id, run_id, mode: "expert"|"quick"|"refresh", window_start?, window_end?, label?, actor }`. Pre-creates the `insight_reports` row (status `generating`) for manual modes so `report_id` is returned immediately; starts the run as a background task. Returns `{ status, run_id, profile, report_id? }`. (`POST /insights/generate` remains for automated stream/scheduler.)

### Custom Analysis — isolated graph (Phase 6)
- `graphs/custom_analysis.py` `run_custom_analysis(survey_id, org_id, run_id, custom_report_id, filter_spec, actor)` — a **fully isolated** ad-hoc analysis. It reuses the shared computational tools (metrics, embed, ABSA, clustering, **read-only** topic discovery via `discover_topics` — never `upsert_survey_topics`) but composes them in its own linear flow that writes **only** `custom_reports` + `custom_report_insights` (+ a `custom-…` blob).
- **HARD INVARIANTS (03 §10/§11):** never writes the `insights` table; never sets `superseded_at`; never mutates `survey_topics`/centroids; `trust_score` capped at 55 when n < `custom_analysis_min_n_for_nps`; **no predictive-layer** insights (only descriptive + diagnostic). `filter_spec` = `{date_from, date_to, segments, topics, metric_types, narrative_depth}`; corpus is capped at `custom_analysis_max_corpus` with `tools/sampling.stratified_sample`.
- **HTTP entry:** `POST /reports/custom/run` (`main.py`, `X-Internal-Key`). Body `{ survey_id, org_id, run_id, report_id, filter_spec, actor }` → runs as a background task → returns `{ status:'started', run_id, report_id }`. Credit pre-flight uses `run_type='custom'` (read-only; backend owns debiting) and returns 402 on insufficient credits / 403 when `custom_analysis_enabled=false`.

### Retention / compaction job (Phase 7)
- `scheduler.run_retention_job()` (nightly, via `run_scheduler_once`) collapses **automated-lane** checkpoints with `meaningful_delta=false` older than the survey's `automated_checkpoint_retention_days` into rollup markers (`lineage_json.rollup_collapsed=true`) and drops their `report_blob_ref` after `RETENTION_BLOB_DROP_DAYS` (default 30). Idempotent (already-collapsed rows are excluded); **never** touches `meaningful_delta=true` rows, manual reports, or the `insights` table. Gated behind `ENABLE_RETENTION_JOB` (default `false` → dev no-op).

### Progressive Tier System (response_stream.py)
- Redis stream consumer listens for new response events
- `should_trigger_progressive_tier()` checks response count vs thresholds (10/40/100/250)
- Redis dedup key `tier:{survey_id}:{tier}` with 30-day TTL prevents duplicate triggers
- On threshold hit: calls backend `/api/insights/:id/generate` with `trigger='stream'`
- **Response tagging sweep (added 2026-07-04)** — a SECOND, independent, much lighter trigger on the
  same consumer: every `response_tagging_batch_size` new-response events (default `1` — tag every
  response as it arrives; survey/org/platform-resolved via `resolve_response_tagging_batch_size`,
  same precedence as `stream_response_threshold`), it calls `lib/response_tagging.py::tag_untagged_responses`
  in-process (no HTTP round-trip, no full pipeline run) — sentiment/emotion/effort scoring +
  existing-topic assignment (`lib/topic_registry.py::assign_batch_to_nearest`) for any response with
  `ai_enriched_at IS NULL`. New-topic *discovery* (unassigned responses buffer into
  `topic_candidates`, same table `node_cluster` reads) is ALSO self-serviced here once the buffer
  crosses `TOPIC_DISCOVERY_CANDIDATE_THRESHOLD` (flat constant, default `25`, shared with
  `node_cluster` so both "enough evidence for a new topic" checks agree) — `tag_untagged_responses`
  clusters by embedding similarity, LLM-names the cluster (`tools/topics.py::discover_topics`),
  inserts the centroid, and tags matching responses, without waiting for a future full pipeline run.
  Only fires for a survey that already has at least one topic (`topic_registry.has_centroids`) — a
  survey's very first topic set still only comes from the full pipeline's bootstrap run (whole-corpus
  clustering), which a per-response sweep can't meaningfully replicate.
  `scheduler.py::run_response_tagging_backlog_sweep`
  (15-min tick, `ENABLE_RESPONSE_TAGGING_BACKLOG_SWEEP` default `true`) is the catch-up path for surveys
  not currently receiving live traffic, or responses whose tagging previously failed (no retry-tracking
  state needed — a failed attempt just leaves `ai_enriched_at` null, so both this sweep and the stream
  trigger naturally retry it next time).

## Harness components: when can each be removed?

Every fallback/legacy path below exists because of a specific past limitation, not by
design intent. Review periodically — a component whose "can be removed when" condition
has been met is dead weight, not a permanent fixture.

| Component | Exists because | Can be removed when |
|---|---|---|
| Legacy ReAct loop (`?legacy=true`, `_run_react_loop_streaming`) | Predates skill-first routing; kept for admin debug parity | Admin debugging no longer needs a non-skill-routed comparison path |
| `find_sync()` difflib fallback in `skill_registry.py` | Covers the window before `warm_router()`'s embeddings finish at startup, or if embedding calls fail | Never — this is a permanent degrade-gracefully path, not a migration artifact |
| `ToolDispatcher` (`lib/tool_dispatcher.py`) sitting unused alongside `dispatch_tool` | Built once as a better-designed mechanism, but the existing ~60 tools were never migrated onto it | Either all new tool-shaped capability actually lands there consistently (validated), or it's deleted if nothing ever adopts it |
| `TOOL_PERMISSION_MAP` covering only 4 of ~60 tools, legacy-path-only | Never resolved whether the other ~56 are intentionally permission-open or an incomplete migration | A deliberate product/security decision is made either way — currently undecided, not fixed |
| EXAMPLES.md → DB-example fallback in `_build_system` | Lets a skill get few-shot examples before it has production history | Never — this is permanent cold-start behavior, not a migration path |

## Environment variables
> **Full list:** `docs/ENV_VARS.md` (canonical). **Adding an `os.getenv("X")`? Add it there AND to the root `.env.example` in the same PR.** Advanced tunables live in `lib/constants.py`. Key ones below.
- `DATABASE_URL` — Postgres connection string (required)
- `REDIS_URL` — Redis (required in production; optional in dev)
- `OPENROUTER_API_KEY` — LLM API key (required)
- `AGENTS_INTERNAL_KEY` — Shared secret with Node.js backend (required; must change from default)
- `AGENTS_ENV` — `'production'` triggers startup validation; default `'dev'`
- `CHECKPOINT_BUCKET` — GCS bucket URI for Crystal checkpoint blobs (production only)
- `GCS_SERVICE_ACCOUNT_KEY` — JSON service account key for GCS writes (production only)

## Running tests
```bash
cd crystalos
.venv/bin/pytest              # full suite (~1400 tests; re-derive with --collect-only, don't trust prose)
.venv/bin/pytest tests/test_crystal.py        # Crystal-specific
.venv/bin/pytest tests/test_skill_runtime.py  # skill runtime / EVALS
```

## Testing rules

Every code change requires a corresponding test change:
- **New function or class** → add tests in `tests/test_<module>.py`
- **Modified function signature** (e.g. new parameter) → add a test that exercises the new parameter and a test that verifies the old behavior is preserved when the parameter is omitted
- **Bug fix** → add a regression test named `test_<what_was_broken>`

Mock patterns:
- Async functions: `unittest.mock.AsyncMock`
- `call_agent()`: patch as `"crystalos.lib.openrouter.call_agent"` (not the local import)
- `get_skill_model()`: patch as `"crystalos.lib.skill_runtime.get_skill_model"`
- Never make real LLM calls in tests

Run tests:
```bash
cd crystalos
.venv/bin/pytest tests/test_skill_runtime.py -v    # single file
.venv/bin/pytest                                    # all 580+ tests
```

## Adding a new Crystal tool
1. Add the JSON Schema tool definition to `crystal/registry.py` (in `TOOL_REGISTRY`)
2. Add an `execute_<tool_name>()` async function to `crystal/tools.py`
3. Add the dispatch entry to `TOOL_EXECUTORS`/`dispatch_tool()` in `crystal/tools.py`
4. Add a unit test in `tests/test_insight_tools.py`

## Adding a new pipeline node
1. Implement `async def node_<name>(state: dict) -> dict` in `graphs/insights.py`
2. Register it: `g.add_node("<name>", node_<name>)`
3. Wire edges: `g.add_edge("prior_node", "<name>")` and `g.add_edge("<name>", "next_node")`
4. Add unit tests in `tests/test_pipeline.py`

## Keeping CrystalOS docs current
- New skill → add `skills/<name>/{SKILL.md,EVALS.md,EXAMPLES.md}` and register in `skills/plugin.json`. It auto-registers (`registry.initialize` + `warm_router` at startup) and is routable via `registry.find` — no code change. Re-derive the skill count if you quote one.
- New `propose_*` action tool → add to `TOOL_REGISTRY` + `ACTION_TOOL_NAMES` (registry) + executor in `crystal/tools.py`; if `proposal_type` ≠ frontend handler name, add a `_PROPOSAL_TYPE_ALIASES` entry (`agents/crystal.py`); add the frontend handler in `CrystalPanel.tsx`; update the proposal table above.
- Changed the default Crystal flow → update "Crystal Intelligence (skill-first)". ReAct is legacy/admin-only (`?legacy=true`), not the default.
- Quoting a test/tool count → re-derive (`pytest --collect-only -q`; count `"name":` in `TOOL_REGISTRY`); don't trust prose.
