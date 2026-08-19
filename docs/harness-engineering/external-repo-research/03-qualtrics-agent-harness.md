# `qualtrics-agent-harness` — Deep Architectural Research

Target repo (read in full): `/Users/spatil/Documents/Projects/InsightExplorerV2/qualtrics-agent-harness`
Comparison target: CrystalOS at `/Users/spatil/Documents/Projects/Experient/crystalos` (`agents/crystal.py`, `lib/skill_runtime.py`, `lib/turn_publisher.py`, `lib/models.py`, `main.py`)

---

## 1. Overview & Purpose

`qualtrics-agent-harness` (package `qualtrics_agent_harness`, current version `0.12.9`) is **not an agent and not a service**. It is a thin, versioned **factory library**: given an app name, it resolves that app's folder from a *separate, independently-versioned* package (`qualtrics_agent_skills`), reads two files (`deepagents.toml` config + `AGENTS.md` system prompt) plus a `skills/` directory, wires declared native tools, and returns a compiled [LangGraph](https://docs.langchain.com/oss/python/deepagents/overview) `DeepAgent` graph. Swap the app name → get a different agent from identical harness code. That harness/skills separation is described (repeatedly, in README, CLAUDE.md, CONTRIBUTING.md, docs/architecture.md) as *the entire point of the repo*.

The three-repo production stack:

| Repo | Role |
|---|---|
| **`qualtrics-agent-harness`** (this repo) | Factory library — builds the graph, owns tools/middleware/identity/sandbox plumbing. Publishes a versioned wheel to Artifactory. |
| `qualtrics-agent-skills` | Per-app content: `AGENTS.md` (system prompt), `deepagents.toml` (config), `skills/<name>/SKILL.md` (progressive-disclosure skill files). Independently versioned/published. |
| `cme-langgraph-service` (CLS) | The actual runtime. Pins both wheels, generates thin `graphs/<app>/graph.py` wrappers calling `build_harness_graph`, serves via LangGraph platform, stamps tracing/version. |

Two apps currently registered: `unified_qa_assist` and `project_assist` (`langgraph.json`, `app_registration/*.py`). Underlying framework is **deepagents** (`^0.6.0`) — LangChain's opinionated agent scaffold providing filesystem-style tools (`read_file`/`write_file`/`edit`/`ls`/`grep`/`glob`), a `SkillsMiddleware` for progressive skill disclosure, pluggable `Backend`s (filesystem/sandbox/composite), and a `create_deep_agent()` entrypoint accepting `middleware=[...]`.

Model calls never touch a provider SDK directly — they go through Qualtrics' internal **Model Inference Gateway (MIG)** via `iq_socrates_sdk`, itself wrapped by a harness compatibility shim (`SerializingMigLLM`) that patches around a real Bedrock Converse API limitation.

---

## 2. Package Architecture — Full Module Map

```
qualtrics_agent_harness/
├── __init__.py                       # package import: load_dev_env() only if APP_ENV=dev (no other side effects)
├── version.py                        # GRAPH_ID + get_graph_version() — reads installed wheel metadata, no monkeypatching
├── constants.py                      # CLAUDE_SONNET_4_6 model id constant, MIG_JWT_ISSUER = "socrates"
├── env.py                            # require_env() (fail-fast), load_dev_env() (.env loader, dev-only, override=True)
│
├── harness/                          # The factory + all agent-lifecycle middleware
│   ├── factory.py                    # build_harness_graph() — THE entry point. resolve_app_dir, load_app_config,
│   │                                 #   discover_skill_names, build_model, _build_filesystem_graph, _build_sandbox_graph
│   ├── tool_registry.py              # _TOOL_MAP: str -> @tool callable; resolve_tools(names) -> list; lazy pandas import
│   ├── state.py                      # HarnessAgentState(DeepAgentState) — extra input/output state fields
│   ├── input_context_middleware.py   # InputContextMiddleware — bridges input state -> config.configurable;
│   │                                 #   also appends report-delimiter + current-date system-prompt directives
│   ├── current_date.py               # _request_with_current_date() — injects "today's date" into every model call
│   ├── applied_filters_middleware.py # AppliedFiltersMiddleware — extracts + publishes this-turn's retrieval filters
│   ├── request_validation_middleware.py # RequestValidationMiddleware — fail-fast identity check at graph entry
│   ├── tool_error_middleware.py      # ToolValidationErrorMiddleware — turns Pydantic validation errors into ToolMessage
│   ├── sandbox_middleware.py         # CodeInterpreterSandboxMiddleware — per-run sandbox skill upload + session lifecycle
│   └── sandbox_paths.py              # SANDBOX_WORKSPACE_ROOT = "/tmp/workspace" (shared constant)
│
├── tools/                            # Native LangChain @tool implementations (no MCP)
│   ├── herodotus_tools.py            # CX/EX dashboard data API (8 tools: filters, search configs, topic hierarchy,
│   │                                 #   aggregate, search_comments, widget_data, fieldset_topic_mapping, valid_text_ids)
│   ├── dfs_tools.py                  # DFS ("Data Filtering Service" / Insight Explorer) — DFSClient class,
│   │                                 #   dfs_search_comments/aggregate/get_records/get_filter_fields
│   ├── lxh_tools.py                  # Location Experience Hub (Frontline) — configurations/subjects/insights
│   └── driver_analysis_tools.py      # trend_insights_analysis — fetches DFS records, runs bootstrapped regression
│                                     #   (pandas/numpy/sklearn) entirely host-side; raw records never hit model context
│
├── utilities/
│   ├── internal_service_auth.py      # get_request_context() — THE identity resolver (JWT > configurable > env);
│   │                                 #   create_service_jwt, build_internal_lb_url, per-service default-getters
│   ├── mig_compat.py                 # SerializingMigLLM — Bedrock Converse API parallel-tool-call serializer
│   ├── logging_context.py            # structlog contextvars binding + a logging.Filter bridge into langgraph_api's root logger
│   ├── mig_compat / trend_insights/  # analysis.py, bootstrapping.py, config.py, constants.py, preprocessing.py,
│   │                                 #   regression.py, utils.py — statistical driver-analysis engine (host-only)
│
├── code_interpreter_client.py        # CodeInterpreterClient — sync httpx client for the code-interpreter HTTP service
├── code_interpreter_config.py        # create_client() wiring (secret + datacenter -> CodeInterpreterClient)
├── code_interpreter_sandbox.py       # CodeInterpreterSandbox(BaseSandbox) — deepagents sandbox adapter over the client
│
├── app_registration/                 # make_graph() wrappers for `make dev` / LangGraph Studio ONLY (not prod)
│   ├── unified_qa_assist.py
│   └── project_assist.py
│
└── tests/
    ├── unit/                         # 20 files — no network, no credentials
    └── integration/                  # requires QTOKEN + VPN; one file (test_mock_graph_integration) needs NEITHER
```

Root-level files: `pyproject.toml` (Poetry, Python 3.11–3.15), `poetry.lock`, `poetry.toml` (Artifactory source), `pip.conf` (Artifactory index), `pylintrc` (Google style, 4-space, 120 col, heavily-disabled ruleset), `langgraph.json` (dev-only graph registration), `Makefile` (dev/build/test/publish targets, Docker-based CI parity), `.jenkins/JenkinsfileMR` + `JenkinsfilePublish`, `docs/architecture.md`, `docs/persistent-thread-sandbox-filesystem.md`.

---

## 3. Core Abstractions Deep-Dive

### 3.1 The factory: `build_harness_graph`

This is the single public entry point and the crux of the whole design. Full signature:

```python
def build_harness_graph(
    app_name: str,
    graph_name: str | None = None,
    config: RunnableConfig | None = None,
) -> CompiledStateGraph:
```

Its docstring states the import-safety invariant explicitly (this is a load-bearing convention, not an incidental comment):

> "IMPORTANT — import safety: importing this module must have NO side effects (no model, no secrets, no network). The deepagents + MIG imports and the model construction are deferred into `build_harness_graph` / `build_model` so a graph is only ever built when actually invoked (per-request). Constructing a model at import/module level would, under the platform's strict startup, crash the whole pod — never do it."

Concretely: every non-stdlib import inside `factory.py`'s functions (deepagents, MIG SDK, code-interpreter client) is a **deferred, function-local import**. A unit test (`test_importing_factory_has_no_side_effects`) pins this invariant directly.

Flow inside `build_harness_graph`:
1. `resolve_app_dir(app_name)` — resolves the app folder via `importlib.resources.files("qualtrics_agent_skills")`, i.e. from whatever copy of the skills wheel is installed (Artifactory in prod, editable-install in dev). Raises `RuntimeError` if the skills package isn't installed at all, `FileNotFoundError` if the named app subfolder is missing.
2. `load_app_config(app_dir)` — reads `deepagents.toml` via stdlib `tomllib`; validates `[agent].model` is present; returns the **whole config dict** (not a narrow subset) so callers can read arbitrary future keys.
3. Backend routing: `cfg["agent"].get("backend")` must be one of `{"agentcore", "filesystem"}` (absent = filesystem). Unknown value → `ValueError` at build time, not at request time.
4. `build_model(...)` — constructs the MIG-backed chat model, resolving `brand_id` with priority **caller JWT → app's static `[mig] brand_id` → env default**, and `issuer`/`prompt_caching` straight from `[mig]` TOML.
5. `resolve_tools(cfg.get("tools", {}).get("requires", []))` — turns a list of string names into actual `@tool` callables via the registry.
6. `_enabled_skill_names(app_dir, config)` — lets a caller narrow the loaded skill set via `config.configurable["enabled_skills"]` (validated: must be a non-empty list of names with no `/` or leading `.`, and each must be a real subfolder — this is a caller-supplied, security-relevant value so it's validated eagerly, not left to deepagents' own downstream guard).
7. Dispatches to `_build_filesystem_graph` or `_build_sandbox_graph`.

Both builder functions assemble an identical **middleware pipeline** (order is a pinned contract, verified by tests):

```python
middleware=[
    RequestValidationMiddleware(),      # fail fast on missing identity, before anything else
    ToolValidationErrorMiddleware(),
    InputContextMiddleware(),
    AppliedFiltersMiddleware(),
    # sandbox backend only:
    CodeInterpreterSandboxMiddleware(...),
]
```

The comment on why validation goes first: *"RequestValidationMiddleware first: fail fast on missing identity before any tool runs or the sandbox session opens."* This is a deliberate, testable invariant (`test_filesystem_graph_validates_identity_first`, `test_sandbox_graph_user_middleware_order`), not incidental ordering.

### 3.2 Backend abstraction (via deepagents, not reinvented)

Two backends selected per-app by one TOML key:

- **`filesystem` (default):** `FilesystemBackend(root_dir=str(app_dir), virtual_mode=True)` — skills and any file the agent writes are rooted at the app's on-disk folder. No sandbox at all; deepagents' built-in file tools operate directly on the filesystem.
- **`agentcore`:** `CompositeBackend(default=sandbox, routes={"/skills/": host_skills}, artifacts_root=SANDBOX_WORKSPACE_ROOT)`. Code execution (`execute`) and most file writes go to a remote VM (AWS Bedrock AgentCore Code Interpreter) reached over JWT-gated HTTP; **only** the `/skills/` route stays on the host `FilesystemBackend` — this is an explicit, tested contract (`test_sandbox_graph_skills_route_is_host_filesystem`) so skill *discovery* never depends on the sandbox being up, while skill *execution* still needs the skill files uploaded into the VM (handled by `CodeInterpreterSandboxMiddleware`, see 3.7).

The harness deliberately does **not** talk to AWS directly. It holds only the code-interpreter service's shared JWT secret (`CODE_INTERPRETER_JWT_SECRET`); that separate microservice owns real AWS credentials. This is a clean security boundary worth noting on its own.

### 3.3 Identity resolution — `get_request_context`

`utilities/internal_service_auth.py::get_request_context(config)` is the single place identity is resolved, used identically by every native tool, by `RequestValidationMiddleware`, and by `factory._caller_brand_id`. Priority order (explicitly documented in both the docstring and `docs/architecture.md`):

1. `config.configurable["langgraph_auth_user"]` — the decoded inbound JWT the LangGraph platform base image verifies and injects (a `DotDict`-like object exposing claims as both attributes and mapping keys — `_auth_user_claim` supports both forms defensively).
2. Explicit `config.configurable` keys (`brand_id`, `user_id`, ...) — kept for eval drivers / non-JWT callers.
3. Env vars (`DEFAULT_BRAND_ID`/`DEFAULT_USER_ID`, `DASHBOARD_EXPLORER_*`) — local dev / Studio fallback.

Raises `RuntimeError(MISSING_IDENTITY_ERROR)` if neither `brand_id` nor `user_id` resolve. `docs/architecture.md` flags this as an **open architectural debt**: today all paths (API/serving vs local/dev) share one fallback chain for backwards compatibility; a documented follow-up is to make them mutually exclusive so the API/serving path fails closed instead of silently falling through to env-based test defaults.

`RequestValidationMiddleware` re-derives context via the exact same function so the fail-fast gate can never diverge from what tools resolve later — a good "single source of truth, checked twice" pattern.

### 3.4 Tool registry — `tool_registry.py`

Flat dict, no decorators-as-registration magic:

```python
_TOOL_MAP: dict[str, Any] = {
    "herodotus_get_page_filters": herodotus_get_page_filters,
    ...
    "lxh_search_insights": lxh_search_insights,
}

def resolve_tools(requires: list[str]) -> list[Any]:
    ...
    for name in requires:
        if name in _LAZY_TOOLS: tools.append(_LAZY_TOOLS[name]())
        elif name in _TOOL_MAP: tools.append(_TOOL_MAP[name])
        else: raise ValueError(f"Unknown tool {name!r}. Register it in harness/tool_registry.py.")
```

Notable: `trend_insights_analysis` (which imports `pandas`/`numpy`/`sklearn`) is registered as a **lazy loader function**, not a direct reference, specifically to avoid importing pandas at plain module import time — a micro-instance of the same import-safety discipline as the factory.

Tool *selection guidance* (when to call which tool) is explicitly kept **out of the system prompt** and pushed into skills instead — a content/logic separation mirrored in CrystalOS's SKILL.md pattern.

### 3.5 Native tool design pattern (Herodotus/DFS/LXH)

All three tool families share one shape:
- A private `_<service>_request` / client class handles JWT minting (`create_service_jwt`), URL construction (`build_internal_lb_url`), and HTTP dispatch with uniform error handling (`httpx.TimeoutException`, `httpx.ConnectError`, generic `Exception` — each logged and returned as a structured `{"success": False, "error": ...}` dict, never raised past the tool boundary).
- Every `@tool` function returns a **string** — either `json.dumps(data, indent=2)` on success or `f"Error: {msg}"` on failure. This "errors are strings prefixed with `Error:`" convention is explicit enough that a test helper codifies it: `assert_ok()` in `tests/integration/conftest.py` asserts `not text.startswith("Error")`.
- Identity/context injection is uniform: tools accept `config: RunnableConfig`, call `get_request_context(config)`, and fall back to caller-omitted params (`fieldset_id`, `text_field_id`) from that resolved context rather than forcing the LLM to always supply them.
- `DFSClient` (in `dfs_tools.py`) factors validate/sign/send into one small class (`from_request`, `_validate`, `_sign`, `_prepare`, `get`/`post`) so the four DFS tool functions don't duplicate boilerplate — a light internal abstraction, not over-engineered.

`driver_analysis_tools.py::trend_insights_analysis` is the one tool that does real host-side compute: it fetches DFS records via `fetch_dfs_records` (async `asyncio.gather` for target+baseline periods), builds a pandas DataFrame, and runs a bootstrapped regression driver analysis (`utilities/trend_insights/`). Docstring explicitly notes: *"Raw records stay in the host process and are never passed through model context"* — i.e. a Tier-0 deterministic-compute pattern living entirely outside the LLM, analogous to CrystalOS's `_build_viz_for_citations` (see §9).

### 3.6 `HarnessAgentState` — typed state extension

```python
class HarnessAgentState(DeepAgentState):
    conversation_context_id: NotRequired[str]
    fieldset_ids: NotRequired[list[str]]
    text_field_id: NotRequired[str]
    text_field_ids: NotRequired[list[str]]
    application: NotRequired[str]
    use_report_delimiters: NotRequired[bool]
    eval_overrides: NotRequired[dict[str, Any]]
    applied_filters: NotRequired[list[dict[str, Any]]]   # OUTPUT ONLY
```

Two categories of fields, both documented inline:
- **Input** (cx/ex-style surface context): callers may pass these either in graph `input` or directly in `config.configurable`; `InputContextMiddleware` reconciles the two (see 3.7).
- **`eval_overrides`**: a deliberately open `dict` rather than named fields, because "the eval set is expected to grow more of these over time" — e.g. `as_of` pins the date `current_date.py` injects, for reproducible evals against a fixed "today."
- **`applied_filters`** (output only): rewritten every turn by `AppliedFiltersMiddleware`, "so it always describes the latest one" — this is the harness's equivalent of a structured, UI-consumable side-channel output, directly parallel to CrystalOS's `applied_filters`-less but conceptually similar `ActionProposal`/`VizSpec` side-channels on `CrystalOutput`.

### 3.7 Middleware — the harness's actual "skill runtime" analog

deepagents' `AgentMiddleware` hook points (`before_agent`/`after_agent`, sync+async, plus `wrap_model_call`/`wrap_tool_call`) are where nearly all harness-specific behavior lives. Five middlewares, each single-purpose:

**`RequestValidationMiddleware`** — `before_agent` (sync+async) calls `_validate_essential_fields()`, which re-derives `get_request_context()` and raises `ValueError` listing exactly which of `REQUIRED_FIELDS = ("brand_id", "user_id")` are missing. Comment: *"Fails the run once, at graph entry, if identity can't be resolved, instead of surfacing as a late/opaque error deep inside a tool or as a side effect of opening the sandbox session."*

**`ToolValidationErrorMiddleware`** — `wrap_tool_call` catches `pydantic.ValidationError` / `pydantic.v1.ValidationError` (LangChain's default tool dispatch would otherwise crash the whole run on a bad-argument tool call) and converts it into a `ToolMessage(status="error")` the model can react to, matching how deepagents' built-in file tools already turn foreseeable errors into tool results rather than exceptions.

**`InputContextMiddleware`** — does double duty:
1. `before_agent`: `_bridge_input_context(state)` copies `conversation_context_id`/`text_field_id`/`application`/`text_field_ids`/`fieldset_ids` from graph **input state** into `config.configurable` *only if not already set there* — reconciling two different calling conventions (cx/ex-style `input=` vs `config.configurable=`) into one.
2. `wrap_model_call`/`awrap_model_call`: appends two unconditional system-prompt edits on every model call — a report-delimiter suppression override (`_SUPPRESS_REPORT_DELIMITERS`, a temporary migration shim) and the current-date directive (delegated to `current_date.py`). These are bundled into one middleware specifically because they're both "unconditional per-call system-prompt edits with no other lifecycle hooks," per the class docstring — a real design call about middleware granularity (bundle by *lifecycle shape*, not by feature).

**`current_date.py`** (not a middleware class itself, but a helper `InputContextMiddleware` calls) — injects `"Today's date is {today} (UTC)..."` into the system prompt on every call, reading the wall clock **per request**, not at import/`__init__` time (explicit comment: *"the module is imported once for the life of the pod, so a date resolved at import or in `__init__` would go stale"*). Supports `eval_overrides.as_of` to pin the date for reproducible evals. Also deliberately date-only (no time-of-day) so that apps using MIG prompt caching on the system block get one cache invalidation per UTC day, not per request.

**`AppliedFiltersMiddleware`** — `after_agent` reads the *finished* message history (not accumulated live as tools run — explicit comment: "so no state is held on an instance shared across runs") and writes `applied_filters` by scanning only the current turn's messages (`_current_turn`: walk backward to the last `HumanMessage`). Filter trees from two different backend shapes (Herodotus's list-of-roots, DFS's single object) are normalized into one canonical shape (`_single_tree`: multiple roots become an explicit `and` node, with roots **canonically sorted** by `json.dumps(..., sort_keys=True)` — because "a conjunction is unordered" and the same two constraints written either order should dedupe to one entry). This is a genuinely subtle piece of domain logic: normalizing heterogeneous filter representations across two backend APIs into one wire format for a downstream UI, entirely independent of the LLM.

**`CodeInterpreterSandboxMiddleware`** (sandbox backend only) — `before_agent`/`abefore_agent` binds the per-run S3 filesystem scope (`<app>/<brand>/<thread>`, sanitized against path-traversal via `_sanitize_s3_segment`) on the sandbox *before* uploading skill files (so the upload's session opens with the right scope already registered), then uploads the (possibly narrowed) skill tree to **two** sandbox roots simultaneously (`SANDBOX_SKILLS_ROOT` = `/skills`, and a TODO-flagged temporary second root `/tmp/workspace/skills` while migration is in flight). `after_agent`/`aafter_agent` stops the session unconditionally (best-effort — logged, never re-raised, since "the session TTL is the backstop if the explicit stop does not land").

### 3.8 Model construction & the MIG compatibility shim

`build_model()` constructs `_MigLLM(SerializingMigLLM, MigCustomLLM)` — a mixin composition, not subclassing `MigCustomLLM` directly, so the serialization/normalization behavior can be unit-tested independent of the real MIG SDK.

`utilities/mig_compat.py::SerializingMigLLM` solves a real, sharply-scoped protocol mismatch: Bedrock's Converse API requires each assistant `tool_use` be followed by exactly one user `toolResult` — a strict 1:1 turn structure. When the model (Claude) issues **parallel** tool calls (`AIMessage(tool_calls=[A,B])` + two `ToolMessage`s), MIG serializes each into a separate Bedrock user message, and Bedrock rejects everything after the first. The shim (`serialize_parallel_tool_calls`) rewrites:

```
AIMessage(tool_calls=[A, B])          AIMessage(tool_calls=[A])
ToolMessage(id=A)               -->   ToolMessage(id=A)
ToolMessage(id=B)                     AIMessage(tool_calls=[B])
                                       ToolMessage(id=B)
```

...into sequential single-call turns, purely at the LangChain-message layer, before every `_generate`/`_agenerate`/`_stream`/`_astream` call — so the system prompt can still instruct the model to "parallelize freely" and never see an MIG rejection. It also normalizes `HumanMessage`/`AIMessage` content from LangSmith's list-of-blocks form down to a plain string (MIG's formatter passes content straight through with no normalization and 400s on a list payload). This is the harness's most surgical, protocol-level piece of engineering — narrowly scoped, well-tested-in-spirit (docstring explains the exact wire-level bug), and completely invisible to app/skill authors.

`build_model` also wires `[mig] prompt_caching` from `deepagents.toml` straight into `llm.default_parameters = {"prompt_caching": {...}}` — persistent per-instance config, not a per-call parameter (the CLAUDE.md notes MIG's parameter merge is shallow, so a future per-call `parameters=` would *replace* rather than merge this — a landmine flagged proactively for future maintainers).

### 3.9 Code Interpreter sandbox stack

Three layers, cleanly separated by responsibility:

- **`code_interpreter_client.py`** — pure, dependency-light (`httpx` + `PyJWT` only) HTTP client. Exposes `execute_code`, `start_session`/`stop_session` (stateful, session-id keyed), and three **bridge helpers** that work around the fact the remote service runs only Python/JS code (no shell, no file-transfer routes): `run_shell` wraps a POSIX command in a small `subprocess.run(shell=True)` Python snippet with a base64-encoded command (sidesteps all shell-quoting hazards) and a sentinel (`__CI_EXIT_CODE__:`) appended to stdout so the real exit code can be recovered from the combined output text; `upload`/`download` similarly base64-shuttle file bytes through `execute`. All of `build_shell_wrapper`/`parse_shell_output`/`build_upload_code`/`parse_upload_output` etc. are **pure functions**, explicitly so they're unit-testable without a live server.
- **`code_interpreter_config.py`** — thin wiring: reads `CODE_INTERPRETER_JWT_SECRET`/`DATACENTER` (fail-fast via `require_env`), constructs the client. No session opened here.
- **`code_interpreter_sandbox.py`** — `CodeInterpreterSandbox(BaseSandbox)`, the deepagents adapter. Only 4 abstract primitives (`execute`, `id`, `upload_files`, `download_files`) are implemented; deepagents derives `read_file`/`write_file`/`edit`/`ls`/`grep`/`glob` from those automatically. Session lifecycle is genuinely subtle:
  - Sessions are keyed by **LangGraph `thread_id`**, not `run_id` — because neither the LangGraph OSS engine nor the `langgraph-api` platform populates `run_id` in per-node `configurable`, while every node (`before_agent`, tools, `after_agent`) reliably sees the same `thread_id`.
  - A `_RunSession` dataclass tracks `session_id`, `created_at`, a `threading.Lock`, and an `active_calls` counter so a session rotation (on TTL expiry) never yanks a session out from under an in-flight `execute`/`upload`/`download` call (`_begin_call`/`_end_call` reservation pattern).
  - `_rotate_if_needed_locked` stops an idle expired session and opens a replacement, syncing the S3 fs_scope out on stop — this is the mechanism documented in `docs/persistent-thread-sandbox-filesystem.md` (below).
  - Direct (non-graph) callers with no `thread_id` fall back to a `ContextVar`-based single-context session (`_DIRECT_RUN_SESSION`), so the same sandbox class works both inside and outside a LangGraph run (used for local scripting/testing).

### 3.10 Persistent thread-scoped sandbox filesystem (docs/persistent-thread-sandbox-filesystem.md)

Worth calling out on its own because it solves a problem CrystalOS doesn't currently have at all: the sandbox VM is ephemeral (torn down every turn, AWS enforces a session timeout), but agent-written files should survive across turns. The solution stays entirely on the Code Interpreter primitive (no AgentCore Runtime, no VPC mount):

- **Scope** = `s3://<bucket>/<app_name>/<brand_id>/<thread_id>/`, each segment sanitized against path traversal.
- **Session start**: `aws s3 sync s3://.../<scope>/ /tmp/workspace` (pull last turn's files in).
- **Session stop**: `aws s3 sync /tmp/workspace s3://.../<scope>/ --sse AES256` (push this turn's changes out). No `--delete` — the prefix *accumulates*, safer against data loss but not a strict mirror.
- A **custom** Code Interpreter (not the built-in `aws.codeinterpreter.v1`, which has no AWS creds inside) is auto-provisioned per-process with an execution role in `SANDBOX` network mode (S3-only egress) — this is done by the separate `code-interpreter` service, not the harness.
- Explicitly documented caveat: durability is only at teardown — a crash or TTL-expiry *before* the stop-sync runs loses that turn's unsynced changes; every prior successfully-synced turn stays safe.

### 3.11 Structured request-scoped logging (`utilities/logging_context.py`)

A genuinely nice piece of platform-integration engineering: rather than threading `config` through every function signature or adding `extra={}` at each log call site, `bound_contextvars(**extract_log_fields(config))` binds `thread_id`/`request_id`/`transaction_id`/`brand_id`/`user_id`/`graph_id`/`graph_version` as `structlog` contextvars once, at the entry point, and every plain `logging.getLogger(__name__)` call anywhere downstream picks them up automatically. The bridge into `langgraph_api`'s own root-logger formatter (which doesn't include `structlog.contextvars.merge_contextvars` in its processor chain, but does include `structlog.stdlib.ExtraAdder()`) is a custom `logging.Filter` (`_ContextVarsExtraFilter`) that copies bound contextvars onto every `LogRecord` as extra attributes — attached per-`Handler` (not per-`Logger`, since a Logger-level filter wouldn't apply to records propagating up from child loggers). `configure_logging()` is explicitly **not** called automatically on import (library mutating the root logger as an import side effect is exactly what Python's logging docs warn against) — it's idempotent and meant to be called once by the hosting service.

---

## 4. State & Memory Management

The harness has **no bespoke state/memory layer** — it relies entirely on:
- **deepagents' `DeepAgentState`** (extended by `HarnessAgentState`) for in-run conversational/tool state — LangGraph's own checkpointer (owned by the hosting `cme-langgraph-service`, not this repo) persists that across turns within a thread.
- **The persistent sandbox filesystem** (§3.10) as an *out-of-band*, S3-backed, thread-scoped durable store for files (not conversation state) — a mechanism CrystalOS has no equivalent of.
- **No skill "example bank" / few-shot memory** of any kind — skills are static `SKILL.md` files loaded fresh each run via deepagents' `SkillsMiddleware`; there is no analog to CrystalOS's `skill_examples` DB table or example-writing/consolidation.
- **No long-term memory across threads** at all — conversation state is thread-scoped only, and the harness has no notion of an org-level or user-level memory store.

This is a meaningful contrast: the harness's state model is "whatever deepagents/LangGraph gives you, plus one durable filesystem trick for the sandbox use case," whereas CrystalOS has hand-rolled Postgres-backed thread management (`crystal_threads`, TTL reset, message-array append with a 100-message cap) and a whole quality-feedback memory loop (`skill_examples`).

---

## 5. Orchestration / Routing Primitives

There is **no LLM-driven routing** in this harness at all — no ReAct loop, no semantic skill router, no tool-selection-by-LLM-turn logic. Two things replace it:

1. **App-level routing is static and config-driven**: one app = one system prompt (`AGENTS.md`) + one declared tool list (`deepagents.toml [tools] requires`) + one skills folder. There is no cross-app routing inside the harness; `cme-langgraph-service` picks which graph to invoke by URL/route, not by any harness logic.
2. **Skill routing is deepagents' own `SkillsMiddleware`** (external to this repo): progressive disclosure means only each skill's `name`+`description` frontmatter enters the system prompt; the model itself decides (via its own reasoning, reading the skill file on demand) which skill to consult, the same way it would decide to read any file. The harness's only lever here is `config.configurable["enabled_skills"]` to *statically narrow* which skills are even discoverable for a given run (used for testing/eval isolation) — it is a allow-list filter, not a router.

This is a fundamentally different shape from CrystalOS's `crystal-analyst` semantic router (`skill_registry.find`, embedding similarity, `top_k`, difflib fallback) — the harness pushes *all* tool-selection reasoning onto the model itself (deepagents' agentic loop over its own built-in tools + the app's declared native tools), with zero harness-side pre-selection logic beyond the static per-app tool/skill lists.

---

## 6. Observability / Telemetry

Deliberately minimal and delegated:

- **Tracing/version stamping is explicitly NOT this repo's job.** `version.py`'s docstring: *"this intentionally does NOT monkeypatch `langgraph_api` internals to stamp the version onto runs... The hosting service (`cme-langgraph-service`) attaches the graph version via its wrapper's `tracing_context` instead."* `get_graph_version()` just reads `importlib.metadata.version(GRAPH_ID)` for the host to consume.
- **Structured logging** is the harness's only first-party observability primitive (§3.11) — request-correlated JSON logs via structlog contextvars, designed for Splunk, with field names deliberately matching `cx_agent_qa_graph`'s existing convention "so Splunk habits carry over."
- **No metrics, no eval framework, no quality-scoring loop** anywhere in this repo. LangSmith (`LANGCHAIN_API_KEY`) and Galileo (`GALILEO_PROJECT`) are listed as optional env vars in CLAUDE.md, but there's no code in this repo that touches them directly — that's presumably `cme-langgraph-service`'s job too.
- **`applied_filters`** (§3.7) is the one harness-authored *structured output* meant for downstream consumption/telemetry — it's a UI/analytics signal, not a quality signal.

This is the single starkest contrast with CrystalOS, which has a first-party `turn_publisher.py` (structured `TurnEvent` telemetry, fire-and-forget DB writes, quality-signal keyword detection, capability-gap logging) and a full quality-eval loop in `skill_runtime.py` (EVALS.md parsing, hybrid structural+LLM-judge scoring, retry-on-failure, example-bank writes). The harness has none of that — it is a much "thinner" layer that assumes the hosting service and skills package carry that weight (skills' own `EVALS.md`-equivalent, if any, would live in `qualtrics-agent-skills`, not here — not confirmed since that repo wasn't in scope).

---

## 7. Testing Utilities Provided

The harness ships no *reusable, exported* test-helper module (nothing importable by downstream consumers), but its own test suite demonstrates several strong, repo-internal patterns:

- **`_FakeToolCallingModel(FakeListChatModel)`** (`tests/integration/test_mock_graph_integration.py`) — subclasses LangChain's `FakeListChatModel` with a no-op `bind_tools` override, because deepagents *always* binds its built-in tools regardless of the app's own declared tools, so any fake model driven through a real compiled graph needs `bind_tools` to at least no-op rather than raise `NotImplementedError`. This is the one general-purpose reusable pattern worth lifting verbatim.
- **Boundary-patching discipline**: `test_factory.py` patches `resolve_app_dir` + `build_model` (the two genuine I/O boundaries — disk resolution and model construction) and lets everything else (`create_deep_agent`, real `FilesystemBackend`, real middleware) run for real — this is explicitly called out in the mock-graph-integration test's docstring as "one boundary short of" what that end-to-end test does, i.e. the suite has a documented *layering* of test depth (unit → boundary-mocked factory tests → real-graph-with-fake-model integration test → real-app-with-fake-model integration test requiring the skills package installed).
- **`_sandbox_graph_patches()` helper** — injects fake modules into `sys.modules` for `code_interpreter_config`/`code_interpreter_sandbox` so sandbox-path tests never need `CODE_INTERPRETER_JWT_SECRET` or network, while still exercising the harness's own wiring logic.
- **`requires_skills` pytest marker gate** (`importlib.util.find_spec("qualtrics_agent_skills") is not None`) — cleanly skips integration-style tests that need the sibling skills package installed, rather than failing CI when it's absent.
- **`assert_ok(text, tool)`** (`tests/integration/conftest.py`) — a one-line helper codifying the "tool errors are strings prefixed with `Error:`" convention (§3.5) as an assertion, so every integration test can assert success uniformly.
- **Test markers**: `unit` (fast/isolated), `integration` (live API + VPN), `eval` (typed-grader evals, excluded from CI, run via a separate `make eval` — this repo doesn't actually define `make eval`, so that target is presumably aspirational/inherited convention from sibling repos).

---

## 8. Config & Deployment

- **Poetry** (`pyproject.toml`), Python `>=3.11,<3.15`, primary dependency source is an internal Artifactory PyPI mirror (`pip.conf`, `poetry.toml`, `[[tool.poetry.source]]`).
- **`langgraph.json`** points only at the two `app_registration/*.py:make_graph` wrappers, and only for local `make dev`/Studio — production graph registration happens entirely inside `cme-langgraph-service` via its own `task graphs:generate` codegen step that reads the installed skills package.
- **Docker-based CI parity**: `Makefile`'s `build`/`test`/`publish` targets all run inside the same Docker image (`script/docker/Dockerfile`) the Jenkins pipelines use, so `make test` locally is a faithful CI rehearsal. `test-local` runs the same pytest command directly via Poetry for fast local iteration (no Docker).
- **Version-bump gate**: `JenkinsfileMR` runs `assert_is_publishable`, which fails *any* MR (including docs-only) if `pyproject.toml`'s version is unchanged from what's already published to Artifactory — a hard, mechanically-enforced "always bump the version" policy, more rigorous than a lint rule because it's checked against the actual published-artifact state, not just diffed against `main`.
- **`.jenkins/JenkinsfileMR`** — lint + test on every MR. **`JenkinsfilePublish`** — build + test + publish to Artifactory on `main` merge (requires `ARTIFACTORY_CREDS`; rejects dirty git state and rejects overwriting an already-published version).
- **Env vars** are documented in one table in CLAUDE.md (`MIG_JWT_SIGNING_KEY`, `APP_ENV`, `DATACENTER`, `QTOKEN`, `CODE_INTERPRETER_JWT_SECRET`, `DEFAULT_BRAND_ID`/`DEFAULT_USER_ID`, `LANGCHAIN_API_KEY`, `GALILEO_PROJECT`) — smaller and flatter than CrystalOS's `docs/ENV_VARS.md`, reflecting the harness's narrower scope.
- **Wheel packaging quirk**: `pyproject.toml`'s `include` block explicitly ships every `**/*.md` file inside the wheel (`SKILL.md`, `AGENTS.md` if any were bundled here — though in practice those live in the *skills* wheel) "so the deployed package carries its skills as read-only assets." Worth noting for CrystalOS if skill content were ever split into its own package.

---

## 9. Direct Comparison to CrystalOS (`crystal.py` / `skill_runtime.py` / `turn_publisher.py` / `models.py`)

| Dimension | `qualtrics-agent-harness` | CrystalOS (current) |
|---|---|---|
| **Framework** | Built *on top of* LangGraph + deepagents — inherits their agent loop, tool-calling protocol, checkpointing, and file-tool primitives for free. | Hand-rolled ReAct loop (`_react_plan_tools`/`_run_react_loop` in `crystal.py`) + hand-rolled skill executor (`SkillRuntime.execute`) — no LangGraph, no deepagents. Every primitive (tool-call parsing, retry, state) is custom. |
| **Agent/app separation** | Hard package boundary: harness (code) vs skills (content), two separately-versioned Artifactory wheels. Cannot accidentally couple app content to harness logic — it's a different pip install. | Skills live in-repo (`crystalos/skills/<name>/{SKILL.md,EVALS.md,EXAMPLES.md}`), same deploy unit as the runtime. Looser boundary, but zero publish/pin ceremony to iterate. |
| **Model/provider abstraction** | One path: MIG via `iq_socrates_sdk`, wrapped by `SerializingMigLLM` for a very specific Bedrock Converse API bug. Single provider family (Bedrock via internal gateway). | `lib/models.py` — explicit multi-vendor routing table per environment (DeepSeek/Gemini/Qwen/OpenAI-OSS/NVIDIA/Kimi) with a documented **cross-vendor QC rule** (creator vendor ≠ QC vendor) and `validate_all_model_configs()` startup gate against a `KNOWN_OPENROUTER_MODELS` allowlist. Far richer model-routing story; harness has none of this (one model per app, one MIG issuer). |
| **Skill execution engine** | No quality gate at all inside this repo — skills are pure system-prompt content read by the model via `SkillsMiddleware`; there is no analog of "execute a skill and score its output." (Any EVALS-equivalent would live in `qualtrics-agent-skills`, out of scope here.) | `SkillRuntime.execute()` — full pipeline: build system prompt (SKILL.md body + reference files + top-3 few-shot examples from a DB table) → call LLM → parse EVALS.md (hybrid structural-keyword + LLM-judge scoring) → retry once with failure context injected → write passing examples back to `skill_examples` (with org-cap + embedding-dedup) → structured `SkillResult`. This is a genuinely more sophisticated, self-improving skill-quality loop than anything in the harness. |
| **Telemetry** | Structured request-scoped logging only (`logging_context.py`); tracing/versioning explicitly delegated to the hosting service. No DB-backed turn events, no quality-signal detection. | `turn_publisher.py` — first-party `TurnEvent` dataclass, fire-and-forget async DB writes to `crystal_turn_events`, keyword-based `detect_quality_signal` (frustration/satisfaction phrase lists), `_update_previous_turn_quality`, capability-gap embedding + logging (`crystal_capability_gaps`). Much richer, product-facing observability. |
| **Identity/auth model** | JWT-first (`langgraph_auth_user` claim, platform-injected) → `configurable` → env, one resolver (`get_request_context`) used everywhere, checked twice (fail-fast middleware + per-tool). Documented API-path-vs-local-path debt. | `CrystalContext` frozen dataclass + `BrandContext` (persona, permitted/restricted features, custom instructions) + `_resolve_permissions(brand, role)` → `effective_perms` gating which tools are even listed in the system prompt (`_build_filtered_tool_list`, `TOOL_PERMISSION_MAP`). More elaborate **authorization** model (brand-level feature gating), less elaborate **authentication** resolution (no JWT claim-chain equivalent — CrystalOS is called via an internal API key, not a per-user JWT). |
| **Turn/thread state** | Delegates entirely to LangGraph's checkpointer (owned by `cme-langgraph-service`) plus the sandbox's S3-backed persistent filesystem for files only. No in-repo thread table. | Hand-rolled `crystal_threads` Postgres table: `get_or_create_thread`/`append_to_thread`, 7-day inactivity TTL reset, 100-message cap with FIFO drop. Simpler mechanism, but entirely bespoke (no framework doing it for free). |
| **Filter/scope transparency to UI** | `AppliedFiltersMiddleware` — normalizes two backends' filter-tree shapes into one canonical form, scoped to the current turn only, written every turn (even empty) so a UI always has an authoritative "what did the agent actually query" signal. | No direct analog — closest concept is `VizSpec`/`ActionProposal` on `CrystalOutput`, but those are proposal/visualization payloads, not a "here's exactly what filters this turn's retrieval used" audit trail. CrystalOS has nothing that plays the same role as `applied_filters`. |
| **Tool-call protocol** | Native LangChain/LangGraph tool-calling — the model emits real tool_calls, deepagents' loop dispatches them, `ToolValidationErrorMiddleware` catches schema-validation exceptions and turns them into `ToolMessage(status="error")`. | Custom JSON protocol over a non-tool-calling-native provider path (OpenRouter): each turn returns one JSON object (`ReActStep`: `thought`/`action`/`tool_calls`/`answer`), parsed via Pydantic, dispatched via `dispatch_tool`. Necessary because "OpenRouter has no native function-calling (JSON mode only)" per `models.py`'s docstring — a real, different constraint than the harness's LangGraph-native path. |
| **Sandbox/code execution** | First-party, fully worked-out sandbox story: JWT-gated HTTP to a separate `code-interpreter` service owning AWS AgentCore creds, session lifecycle keyed by `thread_id`, S3-backed persistent workspace across ephemeral VM teardowns, dual skill-upload roots during a migration window. | No code-execution sandbox at all — `driver_analysis_tools.py`'s equivalent (`trend_insights_analysis`) is the harness's closest CrystalOS parallel: host-side pandas/sklearn compute, never touching model context, but no remote VM. |
| **Deterministic (non-LLM) post-processing** | `AppliedFiltersMiddleware`'s filter-tree normalization; `trend_insights_analysis`'s regression is 100% Python, no LLM. | `_build_viz_for_citations` in `crystal.py` — "Tier-0 deterministic chart selection... never model-chosen," a pure function over already-fetched tool results. Same philosophy (never let the LLM pick/build a structured visual/derived artifact when a deterministic function can), independently arrived at in both codebases. |
| **Versioning/release discipline** | Mechanically enforced: CI fails any MR whose `pyproject.toml` version matches what's already published. Every release is a real Artifactory-pinned wheel bump in a downstream repo. | No equivalent — CrystalOS ships as part of one monorepo deploy, no separate package/version lifecycle for skills or the runtime. |
| **Routing** | None (model itself decides skill/tool use via progressive disclosure; harness only offers a static allow-list). | Semantic router (`skill_registry.find`, embedding similarity + `top_k`, `warm_router()` at startup, difflib fallback) picks **one** skill per turn before any tool call — an actual harness-side routing decision the qualtrics harness has no equivalent of. |

---

## 10. Patterns Worth Adopting in CrystalOS

Ranked roughly by leverage-to-effort:

1. **Import-safety discipline for expensive/networked constructors.** The harness's rule — *no model, no secret, no network access at module import time; everything deferred into the function that's actually invoked per-request* — is directly portable and cheap. CrystalOS's `main.py` does construct things at import/startup (e.g. `validate_all_model_configs()` at import time is fine since it's pure validation, but worth auditing `crystal.py`/`skill_runtime.py` module-level code for any accidental eager client construction). Pin it with a test like `test_importing_factory_has_no_side_effects`.

2. **A canonical "tool call succeeded/failed" contract, enforced by convention + test.** The harness's "every tool returns a string; failures are `Error: ...`-prefixed, never raised" pattern, with `assert_ok()` codifying it, is simpler than what CrystalOS tools currently do ad hoc. CrystalOS's `_format_tool_result`/`dispatch_tool` already return dicts with an `"error"` key on failure — formalizing "every tool error dict has exactly `{"error": str}`, checked by one assertion helper used everywhere in tests" would tighten this further and make `_succeeded`-style checks in `crystal.py` (already present, e.g. `_augment_inp_with_tools`'s `"error" not in r["result"]`) less ad hoc.

3. **A `RequestValidationMiddleware`-style fail-fast identity/context gate, run first.** CrystalOS resolves `org_id`/`user_id`/`survey_id` deep inside handlers today; a single early gate (mirroring `_validate_essential_fields`) that fails loudly and immediately when required context is missing — before any skill routing, tool call, or sandbox-equivalent work starts — would move failure-mode debugging from "opaque error three calls deep" to "one clear error at the top," matching the harness's stated rationale almost verbatim.

4. **The `applied_filters` pattern — a per-turn, machine-readable "what did we actually query" audit output, normalized across heterogeneous backends, written every turn (even empty).** CrystalOS's tool layer already knows what filters/args each call used (`tool_results` entries carry `args`); a small `AppliedFiltersMiddleware`-equivalent function that scans this turn's tool calls and emits a canonical filter-scope object on `CrystalOutput` (distinct from `action_proposals`) would give the frontend the same transparency Herodotus/DFS dashboards get today, and would be nearly free to build given the tool-call log CrystalOS already has in `tool_results`.

5. **`current_date.py`'s "read the clock per request, not at import" discipline, applied to CrystalOS's system-prompt assembly.** Worth an explicit audit: any date/time-sensitive text baked into a system prompt at module scope (rather than at prompt-build time) will go stale for the life of the process — the same failure mode the harness explicitly guards against.

6. **A `SerializingMigLLM`-style compatibility-shim pattern for provider quirks**, i.e. isolate wire-protocol workarounds (parallel-tool-call serialization, content-shape normalization) into one small, independently-unit-tested mixin rather than scattering `if provider == X` branches through the main call path. CrystalOS's OpenRouter-based JSON-protocol ReAct loop already sidesteps the *native* tool-calling problem the harness's shim solves, but if CrystalOS ever needs a provider-specific quirk fix (e.g. a vendor's JSON-mode edge case), the harness's approach — a small, pure, message-list-in/message-list-out transform function, unit-tested with synthetic message lists, wrapped as a mixin — is a clean template.

7. **Pure, synchronous helper functions for anything that builds/parses a wire payload**, mirroring `build_shell_wrapper`/`parse_shell_output`/`build_upload_code`/`parse_download_output` in `code_interpreter_client.py`. These are trivially unit-testable without any live service. CrystalOS's `_normalize_proposal`/`_extract_action_proposals`/`_build_viz_for_citations` already follow this shape well; the harness reinforces it's the right default for *any* new serialization-adjacent logic (e.g. a future workflow-graph builder, a future report-delimiter parser).

8. **Version-gate CI enforcement, if CrystalOS or a sub-package of it is ever split out for independent versioning** (e.g. if `docs/prism` or the automation-hub engine ever becomes its own deployable package) — the "CI fails unless `pyproject.toml`'s version differs from what's already published" mechanism is a strong forcing function worth remembering, though it's not applicable to CrystalOS's current single-monorepo-deploy model.

9. **NOT recommended to adopt wholesale**: the harness's total absence of an eval/quality-scoring loop and DB-backed telemetry is a *weaker* position than CrystalOS's current `skill_runtime.py` + `turn_publisher.py`, not a pattern to emulate — this is explicitly the one area where CrystalOS is already ahead and should keep investing, not regress toward the harness's leaner model.

---

## 11. Open Questions / Gaps

- **What does `qualtrics-agent-skills`' `EVALS.md`-equivalent (if any) actually look like?** Out of scope for this research (a separate repo), but directly relevant: does skill *quality* get gated anywhere in the harness's production path, or is quality control entirely the model's own judgment via `AGENTS.md` instructions? If skills ship with no eval gate at all, that's a materially weaker quality story than CrystalOS's EVALS.md + LLM-judge + retry loop — worth confirming before porting any "skills are just markdown, no runtime gate" assumption into CrystalOS.
- **The documented "API path vs non-API path" identity-resolution debt** (`docs/architecture.md`) — today's single fallback chain (JWT → configurable → env) means a misconfigured production caller could silently fall through to a dev/env default rather than failing loudly. If CrystalOS adopts the JWT-first pattern, it should design in the "fail closed on the serving path" behavior from day one rather than repeating this now-acknowledged harness debt.
- **The TODO-flagged dual skill-upload roots** (`SANDBOX_SKILLS_ROOT` vs `SANDBOX_WORKSPACE_SKILLS_ROOT`) is visibly mid-migration technical debt in the harness itself — not a pattern to copy, just a signal that the harness's sandbox design is still evolving and shouldn't be treated as fully settled/canonical.
- **No visibility into `cme-langgraph-service`** (the actual runtime/tracing/version-stamping owner) was in scope — several harness behaviors (e.g. exact tracing_context wiring, `task graphs:generate` codegen, per-app graph registration mechanics) are described only from the harness side and would need that repo to fully verify.
- **Cost/latency of the LangGraph+deepagents stack vs CrystalOS's leaner hand-rolled loop** wasn't measurable from static reading — the harness inherits real framework overhead (LangGraph's own state graph execution, deepagents' built-in tool set always being bound even when unused per `_FakeToolCallingModel`'s docstring) in exchange for the identity/middleware/sandbox machinery reviewed above. Whether that tradeoff is favorable for CrystalOS's use case (interactive, streaming, latency-sensitive Crystal chat) is a judgment call, not something this read-only research can settle.
- **No test coverage numbers or eval-suite results were run** — this research is a static code read, not a live verification that the harness's tests pass in this environment (skills package isn't installed here, so `@requires_skills`-gated tests would skip).

---

## Key File Reference

| Path | What it is |
|---|---|
| `qualtrics_agent_harness/harness/factory.py` | The entry point — `build_harness_graph`, `build_model`, backend routing |
| `qualtrics_agent_harness/harness/state.py` | `HarnessAgentState` |
| `qualtrics_agent_harness/harness/tool_registry.py` | Tool name → callable registry |
| `qualtrics_agent_harness/harness/input_context_middleware.py` | Input↔configurable bridge + system-prompt directives |
| `qualtrics_agent_harness/harness/current_date.py` | Date injection helper |
| `qualtrics_agent_harness/harness/applied_filters_middleware.py` | Per-turn filter-scope audit output |
| `qualtrics_agent_harness/harness/request_validation_middleware.py` | Fail-fast identity gate |
| `qualtrics_agent_harness/harness/tool_error_middleware.py` | Tool validation-error → ToolMessage |
| `qualtrics_agent_harness/harness/sandbox_middleware.py` | Sandbox skill-upload + session lifecycle |
| `qualtrics_agent_harness/utilities/internal_service_auth.py` | `get_request_context` — identity resolver |
| `qualtrics_agent_harness/utilities/mig_compat.py` | `SerializingMigLLM` — Bedrock parallel-tool-call shim |
| `qualtrics_agent_harness/utilities/logging_context.py` | Request-scoped structlog binding |
| `qualtrics_agent_harness/code_interpreter_client.py` / `_config.py` / `_sandbox.py` | Sandbox VM stack |
| `qualtrics_agent_harness/tools/{herodotus,dfs,lxh,driver_analysis}_tools.py` | Native tools |
| `docs/architecture.md`, `docs/persistent-thread-sandbox-filesystem.md` | Design docs |

CrystalOS comparison files: `/Users/spatil/Documents/Projects/Experient/crystalos/agents/crystal.py`, `crystalos/lib/skill_runtime.py`, `crystalos/lib/turn_publisher.py`, `crystalos/lib/models.py`, `crystalos/main.py`, `crystalos/CLAUDE.md`.
