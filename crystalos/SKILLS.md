# CrystalOS Developer Skills Guide

Reference for writing new Python code in CrystalOS. All patterns reflect the actual codebase.

---

## Tech Stack

- **Language**: Python 3.11+
- **Framework**: FastAPI + uvicorn
- **AI pipelines**: LangGraph (stateful directed acyclic graphs)
- **Validation**: Pydantic v2
- **Database**: psycopg3 async (`psycopg` + `psycopg_pool`) — PostgreSQL
- **Cache / Streams**: `redis.asyncio`
- **LLM gateway**: OpenRouter (GPT-4o, Claude, Llama) via `lib/openrouter.py`
- **Type checking**: mypy strict (configured in `pyproject.toml`)
- **Testing**: pytest + pytest-asyncio

---

## Project Layout

```
crystalos/
  main.py              — FastAPI app entry: routers, lifespan (pool init/close)
  agents/              — Individual AI agent classes
    crystal.py         — Crystal skill-first SSE-streaming Q&A (legacy ReAct loop kept for admin debug)
    copilot.py         — Survey question editor (skill-first: copilot-analyst, legacy fallback)
    creator.py         — Survey creation orchestrator (skill-first: survey-creator, legacy fallback)
  crystal/             — Crystal Intelligence platform
    context.py         — CrystalContext frozen dataclass (org_id, survey_id, thread)
    registry.py        — TOOL_REGISTRY: list of tool definitions (JSON Schema)
    tools.py           — execute_<tool_name>() async functions + dispatch_tool()
  graphs/              — LangGraph pipelines
    insights.py        — Main insight generation pipeline (ingest → publish, 10+ nodes)
    group_insights.py  — Cross-survey group insight pipeline
    nodes/             — Shared node logic extracted for reuse
  lib/                 — Shared utilities
    db.py              — Postgres async pool + helper query functions
    logger.py          — structlog structured logger
    openrouter.py      — LLM API client (call_agent) with retry + backoff
    security.py        — require_internal_key, check_survey_access, sanitise_*
    constants.py       — All tunable constants (thresholds, caps, timeouts)
    metrics.py         — Prometheus counters + histograms
    skill_registry.py  — Discovers SKILL.md files, indexes metadata, dispatches
    skill_runtime.py   — Loads skills, calls LLM, runs evals, retries on failure
    tool_dispatcher.py — Routes tool calls to Python functions via plugin.json
    memory.py          — 4-layer memory (L0 tool cache → L4 org memory)
    tracer.py          — Langfuse distributed tracing (no-op without key)
    hallucination_scorer.py — Deterministic + LLM hybrid hallucination scoring
    pii_scrubber.py    — Regex PII scrubbing for trace inputs
  schemas/             — Pydantic models
    insight.py         — InsightStateModel, InsightRecord, TrustComponents, etc.
  skills/              — Skill directory (36 skills; each = a subdirectory with SKILL.md). Examples:
    plugin.json        — Skill manifest: lists all registered skill paths
    crystal-analyst/   — the conversational Crystal skill (default chat path)
    data-explorer/  trend-analyst/  segment-analyst/  driver-analyst/
    proactive-insights/  report-composer/  survey-creator/  copilot-analyst/  …
  consumers/           — Redis stream consumers
    response_stream.py — Progressive tier trigger listener
  specialists/         — 7 domain specialist agents (NPS, CES, CSAT, etc.)
  tools/               — ML utilities
    embeddings.py      — OpenAI embedding with BoW fallback
    clustering.py      — Cosine similarity clustering
    sentiment.py       — ABSA via LLM
    metrics.py         — NPS/CSAT/CES computation
    topics.py          — Topic discovery and upsert
  tests/               — pytest test files
  pyproject.toml       — mypy strict configuration
  pytest.ini           — pytest configuration
  Makefile             — Common dev commands (make run-dev, make test, etc.)
```

---

## FastAPI Route Patterns

All routes are mounted in `main.py`. Internal routes are protected by `require_internal_key`.

```python
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from crystalos.lib.security import require_internal_key

router = APIRouter()

class MyRequest(BaseModel):
    survey_id: str
    org_id: str
    trigger: str = "manual"

class MyResponse(BaseModel):
    run_id: str
    status: str

@router.post(
    "/my-feature/start",
    response_model=MyResponse,
    dependencies=[Depends(require_internal_key)],
)
async def start_my_feature(body: MyRequest) -> MyResponse:
    # org_id comes from the validated request body (set by Node.js backend after Clerk auth)
    run_id = await _kick_off(body.survey_id, body.org_id)
    return MyResponse(run_id=run_id, status="running")
```

Register the router in `main.py`:

```python
from crystalos.routes.my_feature import router as my_feature_router
app.include_router(my_feature_router, prefix="/api")
```

---

## Database Patterns

The database pool uses **psycopg3 async** (`psycopg`). Always use parameterized queries (`%s` placeholders, not `$1` — that is the pg format, psycopg uses `%s`).

```python
from crystalos.lib import db

# List query
async with db._pool_conn().connection() as conn:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT id, title FROM surveys WHERE org_id = %s AND deleted_at IS NULL",
            (org_id,),
        )
        rows = await cur.fetchall()
        cols = [d[0] for d in cur.description]
        surveys = [dict(zip(cols, row)) for row in rows]

# Single row
async with db._pool_conn().connection() as conn:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT id, title, status FROM surveys WHERE id = %s AND org_id = %s",
            (survey_id, org_id),
        )
        row = await cur.fetchone()
        if row is None:
            return {"error": "survey not found"}
        cols = [d[0] for d in cur.description]
        survey = dict(zip(cols, row))

# Insert with RETURNING
async with db._pool_conn().connection() as conn:
    async with conn.cursor() as cur:
        await cur.execute(
            "INSERT INTO my_table (org_id, name) VALUES (%s, %s) RETURNING id",
            (org_id, name),
        )
        row = await cur.fetchone()
        new_id = row[0] if row else None
    await conn.commit()
```

**Always use `%s` placeholders. Never f-strings or string concatenation in SQL.**
**Always include `org_id` in WHERE clauses for tenant isolation.**

---

## How to Add a New Crystal Tool

Crystal's `TOOL_REGISTRY` has 35 tools (default path calls them directly via skill
routing; the legacy ReAct loop is admin-only). To add another:

**Step 1 — Add tool definition to `crystal/registry.py`:**

```python
# In TOOL_REGISTRY list:
{
    "name": "my_new_tool",
    "description": "What it does — be specific about inputs and output shape for the LLM.",
    "scope": "survey",  # "survey" | "group" | "all"
    "input_schema": {
        "type": "object",
        "properties": {
            "survey_id": {"type": "string", "description": "UUID of the survey"},
            "limit":     {"type": "integer", "default": 10},
        },
        "required": ["survey_id"],
    },
},
```

**Step 2 — Add executor in `crystal/tools.py`:**

```python
async def execute_my_new_tool(ctx: CrystalContext, params: dict[str, Any]) -> dict[str, Any]:
    """Return structured data for Crystal to reason over."""
    survey_id = params.get("survey_id") or ctx.survey_id
    if not survey_id:
        return {"error": "survey_id required"}

    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT id, name FROM my_table WHERE survey_id = %s AND org_id = %s",
                    (survey_id, ctx.org_id),
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]
                items = [dict(zip(cols, r)) for r in rows]
        return {"items": items, "count": len(items)}
    except Exception as exc:
        logger.error("execute_my_new_tool_failed", error=str(exc), survey_id=survey_id)
        return {"error": str(exc)}
```

**Step 3 — Register in `dispatch_tool()` in `crystal/tools.py`:**

```python
# In the dispatch_tool() function, add:
"my_new_tool": execute_my_new_tool,
```

**Step 4 — Add unit tests in `tests/test_insight_tools.py`.**

---

## How to Add a New LangGraph Pipeline Node

Nodes in `graphs/insights.py` receive and return partial state dicts.

```python
from typing import Any, TypedDict

# Define (or extend) the pipeline state TypedDict at the top of the file:
class InsightState(TypedDict):
    survey_id: str
    org_id: str
    responses: list[dict[str, Any]]
    # ... add your new field:
    my_result: dict[str, Any] | None

# Implement the node function:
async def node_my_step(state: InsightState) -> dict[str, Any]:
    """Returns a partial state update dict."""
    survey_id = state["survey_id"]
    responses = state.get("responses", [])

    # Do work...
    result = {"computed": len(responses)}

    return {"my_result": result}  # only the keys you're updating

# Register in run_insight_generation():
g.add_node("my_step", node_my_step)
g.add_edge("topics", "my_step")
g.add_edge("my_step", "narrate")
```

Nodes must return partial state dicts — only include keys that changed. LangGraph merges them.

---

## Pydantic Models (FastAPI request / response)

```python
from pydantic import BaseModel, Field
from typing import Any

class InsightRequest(BaseModel):
    survey_id: str
    org_id: str
    run_id: str | None = None
    trigger: str = "manual"
    force_regenerate: bool = False

class InsightResponse(BaseModel):
    run_id: str
    status: str
    message: str = ""

# In a route:
@router.post("/insights/generate", response_model=InsightResponse)
async def generate_insights(
    body: InsightRequest,
    _: None = Depends(require_internal_key),
) -> InsightResponse:
    run_id = await kick_off_pipeline(body.survey_id, body.org_id)
    return InsightResponse(run_id=run_id, status="running")
```

---

## Type Annotation Patterns (mypy strict)

The project uses `mypy --strict`. Every function needs full annotations.

```python
from __future__ import annotations
from typing import Any
from collections.abc import Sequence

# Annotate ALL return types:
async def get_surveys(org_id: str) -> list[dict[str, Any]]:
    ...

# For optional returns:
async def get_survey(survey_id: str, org_id: str) -> dict[str, Any] | None:
    ...

# TypedDict for LangGraph state:
from typing import TypedDict

class MyState(TypedDict):
    org_id: str
    survey_id: str
    items: list[dict[str, Any]]
    result: dict[str, Any] | None
    error: str | None

# Avoid bare dict — use dict[str, Any] or a TypedDict
def process(data: dict[str, Any]) -> dict[str, Any]:
    ...

# For unknown values from DB rows / JSON blobs:
row: dict[str, Any] = dict(zip(cols, raw_row))
```

---

## Logging

CrystalOS uses `structlog` (bound to `logger` from `lib/logger.py`).

```python
from crystalos.lib.logger import logger

# Info
logger.info("survey_pipeline_started", survey_id=survey_id, org_id=org_id, trigger=trigger)

# Warning
logger.warning("slow_tool_call", tool="get_verbatims", ms=elapsed_ms, org_id=org_id)

# Error
logger.error("tool_execution_failed", tool=tool_name, error=str(exc), org_id=org_id)
```

Rules:
- Use keyword arguments for structured context — not formatted strings.
- Always include `org_id` for traceability.
- Never log raw LLM responses that may contain PII.
- Use `lib/pii_scrubber.py` before logging user-supplied text in traces.

---

## Security Rules — Never Violate

1. **Parameterized queries only**: `await cur.execute("WHERE id = %s", (id,))` — never f-strings in SQL.
2. **`org_id` scoping on all queries**: every query touching user data must include `org_id` in the WHERE clause.
3. **Internal API auth**: all endpoints must use `Depends(require_internal_key)` from `lib/security.py`. The Node.js backend passes `X-Internal-Key` header.
4. **Survey access verification**: use `check_survey_access(survey_id, org_id)` from `lib/security.py` before any survey operation. Returns `None` if not found, raises `PermissionError` on org mismatch.
5. **No autonomous writes**: Crystal action tools return *proposals* — structured JSON the frontend presents for user confirmation. Crystal never writes to the DB directly.
6. **Never log raw LLM responses** containing potential PII. Use `pii_scrubber.scrub()` before logging.
7. **Input sanitisation**: use `sanitise_intent()` and `sanitise_org_context()` from `lib/security.py` before passing user-supplied strings to LLM prompts.

---

## Testing Patterns

```python
# tests/test_my_feature.py
import pytest
from unittest.mock import AsyncMock, patch

@pytest.mark.asyncio
async def test_my_tool_returns_items() -> None:
    mock_rows = [("uuid-1", "Topic A"), ("uuid-2", "Topic B")]
    mock_ctx = AsyncMock()
    mock_ctx.org_id = "test-org"
    mock_ctx.survey_id = "test-survey"

    with patch("crystalos.crystal.tools.db._pool_conn") as mock_pool:
        # Set up mock cursor
        mock_cur = AsyncMock()
        mock_cur.fetchall.return_value = mock_rows
        mock_cur.description = [("id",), ("name",)]
        mock_pool.return_value.__aenter__ = AsyncMock(return_value=AsyncMock(
            cursor=lambda: mock_cur
        ))
        result = await execute_my_new_tool(mock_ctx, {"survey_id": "test-survey"})

    assert result["count"] == 2
    assert result["items"][0]["name"] == "Topic A"

# Run tests:
# cd crystalos && .venv/bin/pytest tests/test_my_feature.py -v
```

For integration tests, see `tests/test_integration_sprint.py` as a reference for full pipeline smoke tests.

---

## Skill Directory Structure

Each skill in `skills/<name>/` needs these three files:

```
skills/my-skill/
  SKILL.md      — YAML frontmatter + prompt body
  EVALS.md      — Quality criteria / evaluation rubric
  EXAMPLES.md   — Example inputs and expected outputs (or stub)
```

Add the skill path to `skills/plugin.json`:

```json
{
  "skills": [
    "skills/my-skill/SKILL.md",
    "..."
  ]
}
```

### EVALS.md format (required — must be a markdown table)

`EVALS.md` **must** use a markdown pipe-table — `_parse_evals_md` (`lib/skill_runtime.py`)
only extracts lines starting with `|`; prose or bullet-list criteria silently parse to an
empty list and the skill falls through to the baseline output gate (non-empty content
check, max score 0.70) instead of your actual quality bar:

```markdown
| ID | Criterion | Weight | Threshold |
|----|-----------|--------|-----------|
| E1 | Output is valid JSON with actions array | 30 | must pass |
| E2 | actions has 1-4 entries with id, type, priority, title, description, params | 25 | must pass |
| E3 | Each action references specific data from input | 25 | >= 0.80 |
```

`threshold` is either `must pass` (any failure zeroes the whole skill score) or a numeric
bound like `>= 0.75`. Always confirm a new/edited EVALS.md actually parses non-empty
(`SkillRuntime()._parse_evals_md(open("EVALS.md").read())`) — a silently-empty EVALS.md is
easy to miss in review since the skill still runs, it just never enforces anything.

Three criterion shapes are graded **deterministically** (no LLM call) if the wording
matches, cheaper and more reliable than the LLM judge:
- `STRUCTURAL_KEYWORDS` — generic keywords like "valid json", "required fields", "word
  count", "count", "non-empty".
- `"<field> has N-M entries with <key1>, <key2>, ..."` — array-length + per-entry-keys
  check, matched via regex directly off the criterion text.
- `"<field> is one of: a, b, c"` — enum-membership check, same regex-off-the-text approach.

If a criterion needs a bespoke deterministic check tied to your specific skill (not a
generic reusable pattern), register a validator in `lib/skill_validators.py`'s
`SKILL_CRITERION_VALIDATORS` dict, keyed by `(skill_name, criterion_id)` — it's checked
before the generic structural/LLM dispatch and its score flows into the existing
must-pass/retry machinery like any other criterion. See `validate_workflow_registry_grounding`
for a real example (workflow-analyst E2).

### SKILL.md frontmatter fields

```yaml
---
name: my-skill              # kebab-case, max 64 chars, globally unique
version: 1.0.0              # semver — bump minor for prompt changes
shared: true                # true = platform skill, false = internal-only
description: |
  What this skill does, including input shape and output shape.
  The LLM reads this to decide when to invoke it.
allowed-tools: get_survey_overview get_verbatims   # space-delimited tool names from plugin.json
max_output_tokens: 2048     # optional, defaults to model max
max_retries: 1              # optional, default 1 (retries on eval failure)
timeout_seconds: 60         # optional, default 60
---

(Prompt body follows here)
```

---

## Running mypy

```bash
cd crystalos && python -m mypy . --config-file pyproject.toml
```

Config lives in `pyproject.toml`. Third-party packages without stubs (langgraph, langchain, psycopg, structlog, etc.) are silenced via `[[tool.mypy.overrides]]`.

---

## Running Tests

```bash
cd crystalos

# All tests (~1400; re-derive with --collect-only, don't trust this number)
.venv/bin/pytest

# Crystal-specific
.venv/bin/pytest tests/test_crystal.py -v

# Skill framework tests
.venv/bin/pytest tests/test_skill_registry.py tests/test_skill_runtime.py \
                 tests/test_tool_dispatcher.py tests/test_memory.py -v

# Integration smoke tests
.venv/bin/pytest tests/test_integration_sprint.py -v
```

---

## Environment Variables

| Variable               | Required | Description                                              |
|------------------------|----------|----------------------------------------------------------|
| `DATABASE_URL`         | yes      | Postgres connection string                               |
| `REDIS_URL`            | prod     | Redis URL (optional in dev — consumers skip gracefully)  |
| `OPENROUTER_API_KEY`   | yes      | LLM API key                                              |
| `AGENTS_INTERNAL_KEY`  | yes      | Shared secret with Node.js backend (must change default) |
| `AGENTS_ENV`           | no       | `'production'` triggers startup validation (default dev) |
| `CHECKPOINT_BUCKET`    | prod     | GCS bucket URI for Crystal checkpoint blobs              |
| `GCS_SERVICE_ACCOUNT_KEY` | prod  | JSON service account key for GCS writes                  |
| `USE_SKILL_RUNTIME`    | no       | `true` to enable skill framework (default false)         |
| `LANGFUSE_PUBLIC_KEY`  | no       | Enables Langfuse tracing (no-op if absent)               |

---

## Key Architectural Invariants

- **Crystal never writes to the DB autonomously** — action tools return proposals for user confirmation.
- **All DB queries include `org_id`** — tenant isolation is structural, not optional.
- **The Node.js backend is the only caller** — CrystalOS is not internet-facing. The `X-Internal-Key` header is the auth boundary.
- **LangGraph state is a TypedDict** — nodes receive the full state and return partial update dicts.
- **SSE streams are per-org rate-limited** — 10 Crystal requests per org per minute via Redis sliding window.
- **Pipeline heartbeat**: `agent_runs.heartbeat_at` is updated every 30s. Zombie sweep reaps runs stale > 15 min.
- **Insight deduplication**: `ON CONFLICT (survey_id, insight_hash, time_window)` — re-running a pipeline upserts rather than duplicates.
