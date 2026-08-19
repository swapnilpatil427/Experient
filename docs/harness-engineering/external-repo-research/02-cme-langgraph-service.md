# Deep-Dive: `cme-langgraph-service`

Repo: `/Users/spatil/Documents/Projects/InsightExplorerV2/cme-langgraph-service`
Read: README.md, CLAUDE.md, langgraph.json(+.dev.json), all of `graphs/`, all of
`custom_routes/`, `pyproject.toml`, `pip.conf`, `Dockerfile`, `Taskfile.yml`,
`scripts/generate_graphs.py`, all of `docs/`, all of `tests/`, `postman/`.

---

## 1. Overview & Purpose

**CME LangGraph Service (CLS)** is Qualtrics Core Model Engineering's **consumer
service** on top of a shared internal PaaS called **SLGP** (Socrates LangGraph
Platform) — a company-wide "base image" that already implements a full
LangGraph Platform server (auth, multi-tenant data isolation, Postgres/Redis
persistence, metrics, the run/thread/store/cron REST API). CLS was split out of
the SLGP monolith in May 2026 as part of a broader move to many small
single-team "consumer services" riding the same base image, each hosting only
the graphs one team owns.

**The critical thing to understand about this repo: it contains almost no
graph logic.** It is a *deployment and registration shell*. The actual
LangGraph node/state/routing code for every hosted graph lives in **separately
published, versioned Python packages**:

| Package (pinned in `pyproject.toml`) | Hosts |
|---|---|
| `cx-agent-qa-graph==2.11.3` | `cx_agent_qa_graph` — hand-written graph, analyzes CX dashboard/survey feedback |
| `ex-agent-qa-graph==2.9.3` | `ex_agent_qa_graph` — hand-written graph, analyzes EX (employee experience) data |
| `qualtrics-agent-harness==0.12.9` + `qualtrics-agent-skills==0.6.2` | `unified_qa_assist`, `unified_qa_ex`, `unified_aipc`, `insight_explorer`, `project_assist`, `frontline_recommended_actions` — six "skills apps," all built by one shared **DeepAgent harness factory** (`build_harness_graph(app_name)`), differentiated only by which skill-bundle/app config the harness loads at runtime |

So this repo answers "**which graphs are being served, on what infra, under
what auth, with what tracing**" — not "how does the graph reason." That's the
single most load-bearing fact for anyone trying to port its patterns: the
*graph topology* patterns worth studying live in the upstream packages (not
present in this checkout); what **is** fully present and portable here is the
**operational envelope** around graphs — wrapper conventions, tracing/version
stamping, auth, generated-code hygiene, deployment plumbing.

**Problem this service solves:** give every "CME" (Core Model Engineering)
LangGraph-based agent a production home — auth, observability, scaling,
on-call — without every agent team having to reinvent a FastAPI+LangGraph
deployment, or without cramming unrelated teams' agents into one shared
monolith (the old SLGP-hosts-everything model, which this migration is moving
away from).

---

## 2. Architecture Diagram

```
                         Caller (Herodotus, other internal services)
                                        │  HTTPS + X-JWT (HS256, aud=socrates-langgraph-platform)
                                        ▼
        internal-lb.<dc>.<domain>/cme-langgraph-service/*   (LBaC route)
                                        │
                                        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ cme-langgraph-service pod                                                  │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │ langgraph_platform_base image (SLGP, v1.2.0)                      │    │
│  │  • JWT auth + data isolation middleware (brandId/userId scoping)  │    │
│  │  • LangGraph runtime + worker pool (Postgres + Redis backed)      │    │
│  │  • Full LangGraph Platform REST surface:                         │    │
│  │      /assistants /threads /runs /runs/stream /store /crons        │    │
│  │  • /ok /info /aggregated-metrics (public)                        │    │
│  │  • FastAPI app object at src/app.py:app                          │    │
│  └───────────────────────────────────────────────────────────────────┘    │
│                            │  LANGGRAPH_HTTP overridden to:                │
│                            ▼  custom_routes/app.py:app                    │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │ custom_routes/app.py                                              │    │
│  │   from src.app import app   # same platform app, routes appended  │    │
│  │   + GET /proactive-recommendations/{app_name}   (in-handler auth) │    │
│  └───────────────────────────────────────────────────────────────────┘    │
│                            │                                              │
│                            ▼  LANGSERVE_GRAPHS env (built from            │
│                               langgraph.json at image build time)         │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │ graphs/  (THIS REPO'S actual payload — thin wrappers)             │    │
│  │                                                                    │    │
│  │  Hand-written (own published pkg per graph):                     │    │
│  │   • cx_agent_qa_graph/graph.py  → cx_agent_qa_graphs pkg          │    │
│  │   • ex_agent_qa_graph/graph.py  → ex_agent_qa_graphs pkg          │    │
│  │       (+ tiktoken_import_shim.py — defers a network call)         │    │
│  │                                                                    │    │
│  │  Generated (scripts/generate_graphs.py, one shared template):    │    │
│  │   • unified_qa_assist/graph.py  ┐                                │    │
│  │   • unified_qa_ex/graph.py      │  all call the SAME              │    │
│  │   • unified_aipc/graph.py       ├─ qualtrics_agent_harness         │    │
│  │   • insight_explorer/graph.py   │  .build_harness_graph(app_name) │    │
│  │   • project_assist/graph.py     │  factory — a DeepAgent          │    │
│  │   • frontline_recommended_...   ┘  (skills + tools + sandbox)     │    │
│  │                                                                    │    │
│  │  Shared helpers (graphs/_*.py, hand-written, imported by all      │    │
│  │  generated wrappers):                                             │    │
│  │   • _mig_content_shim.py   — monkeypatches MIG multi-turn bug     │    │
│  │   • _provenance.py         — harness/skills version → metadata   │    │
│  │   • _tool_status_callback.py — streams "tool_running"/"thinking" │    │
│  │                                progress events to the client      │    │
│  │   • dev_auth.py            — local-only X-JWT handler (langgraph │    │
│  │                                dev only, never shipped active)   │    │
│  └───────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼ (async, IRSA / SQS)              ▼ (per-graph project)
                     Galileo trace ingestion               LangSmith (per-DC)
                     (stage-only, b1-prv)                  cx_agent_qa_graph / ex_.../
                                                            unified_qa_assist / ...
```

Key relationship: **`custom_routes/` sits *beside* `graphs/`, both bolted onto
the same base-image FastAPI app** — one extends the HTTP surface (a static,
non-graph, non-LLM endpoint), the other extends the LangGraph registry
(`LANGSERVE_GRAPHS`). They don't share code and are wired via two independent
mechanisms (`LANGGRAPH_HTTP` app override vs. `langgraph.json`/`LANGSERVE_GRAPHS`).

---

## 3. State & Schema Design

Because 6 of 8 graphs are generated calls into an opaque harness factory, and
the other 2 import a compiled `Graph` object from an external package, **no
state `TypedDict`/Pydantic schema is defined anywhere in this repo.** The
`config: RunnableConfig` object passed into every wrapper's `graph(config)`
function is the only "state-adjacent" shape this repo touches directly, and
even that is treated as an opaque dict with a few known keys:

```python
configurable = config.get("configurable", {})
metadata = {**prov}
if configurable.get("x-transaction-id"):
    metadata["transaction_id"] = configurable["x-transaction-id"]
if configurable.get("x-parent-request-id"):
    metadata["parent_request_id"] = configurable["x-parent-request-id"]
config.setdefault("metadata", {}).update(metadata)
```

Everything else — `messages`, `conversation_context_id`, `brand_id`,
`fieldset_id`, `application`, etc. — is documented only informally, in
`docs/caller-onboarding.md` / `docs/postman.md`, as the **wire contract of the
`input` and `config.configurable` JSON bodies** each graph expects (see §6
below). The authoritative schema (`state.py`) lives in the upstream package
repos (`cx-agent-qa-graph`, `ex-agent-qa-graph`), which are **not** part of
this checkout.

This is a deliberate consequence of the "thin consumer, fat upstream package"
split: state design is an upstream-package concern; this repo's job is
transport, auth, and observability plumbing around whatever state the
upstream graph defines.

---

## 4. Graph-by-Graph Breakdown

### `cx_agent_qa_graph` (hand-written wrapper, `graphs/cx_agent_qa_graph/graph.py`)

- **Purpose:** CX agent — answers questions over customer-feedback / dashboard
  data (Herodotus-backed).
- **Wrapper responsibilities (full file, 52 lines):**
  1. Gate + init Galileo tracing (`enable_galileo_tracing`) — **must run before
     any LangChain import**, gated on `TRACE_QUEUE_URL`, wrapped in try/except
     so a tracing failure can't crash the pod.
  2. Import the compiled graph class + version metadata from the published
     package: `from cx_agent_qa_graphs.cx_agent_qa_graph.graph import Graph`.
  3. `graph(config)` is an `@contextlib.asynccontextmanager` — LangGraph
     Platform calls it per-run and expects an async context manager yielding
     the compiled graph:
     ```python
     @contextlib.asynccontextmanager
     async def graph(config):
         graph_version = get_graph_version()
         config.setdefault("metadata", {})["graph_version"] = graph_version
         with tracing_context(
             project_name=GRAPH_NAME,
             metadata={"graph_id": GRAPH_ID, "graph_version": graph_version},
         ):
             yield Graph.get_compiled_graph(GRAPH_NAME)
     ```
  4. Stamps `graph_version` into both the LangSmith `tracing_context` metadata
     *and* `config["metadata"]` (the graph package's own logger reads the
     latter — without it, Splunk logs `graph_version=NOT_FOUND`).
- **Actual node topology (from docs, not this repo):** per
  `docs/caller-onboarding.md`, the real graph is
  `setup_state → query_planner → data_retriever → data_filtering →
  response_generator`. `setup_state` calls out to **Herodotus** using
  `conversation_context_id` and needs the JWT's `product`/`userType` claims for
  tenancy checks (this is the #1 documented failure mode in the on-call
  runbook: "`setup_state` failures with HTTP 4xx/5xx from Herodotus").
- **Input shape:**
  ```json
  { "messages": {"type": "user", "content": "..."},
    "conversation_context_id": "<uuid>" }
  ```
- **State schema:** owned entirely by `cx_agent_qa_graphs` package (not in this
  checkout).

### `ex_agent_qa_graph` (hand-written wrapper, `graphs/ex_agent_qa_graph/graph.py`)

- **Purpose:** mirror of cx, for EX (employee-experience) data. "Same shape as
  cx. Different downstream logic. Same `product` + `userType` requirement."
  (docs/caller-onboarding.md)
- **Wrapper is byte-for-byte the cx pattern**, with one extra concern: the
  underlying `ex_agent_qa_graphs` package calls `tiktoken.encoding_for_model()`
  **at import time**, which does an HTTPS fetch to
  `openaipublic.blob.core.windows.net` — fatal in prod's restricted-egress
  network. The wrapper works around this with a **lazy tiktoken shim**
  (`tiktoken_import_shim.py`) that must be imported and `.apply()`-ed *before*
  the `ex_agent_qa_graphs` import, and before even the Galileo init (order
  matters twice over: shim → Galileo → package import):
  ```python
  class _LazyEncoding:
      __slots__ = ("_model_name", "_enc")
      def _ensure(self):
          if self._enc is None:
              self._enc = _original(self._model_name)   # deferred to first use
      def encode(self, *a, **kw): self._ensure(); return self._enc.encode(*a, **kw)
      ...
  ```
  This forces an `E402` (import-not-at-top) ruff exception, scoped per-file in
  `pyproject.toml`.
- **State schema:** owned by `ex_agent_qa_graphs` (not in this checkout).

### The six "skills app" graphs — `unified_qa_assist`, `unified_qa_ex`,
`unified_aipc`, `insight_explorer`, `project_assist`, `frontline_recommended_actions`

These are **not distinct graphs from this repo's point of view** — they are
the **same generated template**, parameterized only by `GRAPH_NAME` (i.e.
`app_name` in the skills package), each carrying a `# @generated by
scripts/generate_graphs.py — DO NOT EDIT` marker on line 1. Full shared shape:

```python
@contextlib.asynccontextmanager
async def graph(config: RunnableConfig):
    prov = get_provenance(graph_id=GRAPH_NAME)          # {graph_id, harness_version, skills_version}
    configurable = config.get("configurable", {})
    metadata = {**prov}
    if configurable.get("x-transaction-id"):
        metadata["transaction_id"] = configurable["x-transaction-id"]
    if configurable.get("x-parent-request-id"):
        metadata["parent_request_id"] = configurable["x-parent-request-id"]
    config.setdefault("metadata", {}).update(metadata)

    with tracing_context(project_name=GRAPH_NAME, metadata=metadata):
        with bound_contextvars(**extract_log_fields(config)):
            # asyncio.to_thread: backend="agentcore" does blocking setup
            # (Code Interpreter HTTP client + JWT signer) at construction time.
            compiled = await asyncio.to_thread(build_harness_graph, GRAPH_NAME, config=config)
            yield compiled.with_config({"callbacks": [ToolStatusCallbackHandler(TOOL_STATUS_MAP, THINKING_STATUS)]})
```

Key design points:
- **`build_harness_graph(GRAPH_NAME, config=config)`** — the entire graph
  (nodes, routing, tools, state) is constructed *inside the harness package*
  (`qualtrics-agent-harness`, which pulls in `deepagents`), parameterized by
  which "app" folder (from `qualtrics-agent-skills`) to load skills from. This
  repo never sees a node or edge for these six graphs.
- **Construction is per-request, not once at import time** — `graph(config)`
  is called per run, and `build_harness_graph` runs inside `asyncio.to_thread`
  because it does blocking I/O (spins up a Code Interpreter HTTP client + JWT
  signer for the sandbox). This is notably different from cx/ex, which call
  `Graph.get_compiled_graph(...)` (implying the compiled graph is memoized/
  reused across runs, built once).
- **`ToolStatusCallbackHandler`** (`graphs/_tool_status_callback.py`) is a
  `langchain_core.callbacks.AsyncCallbackHandler` bolted onto the compiled
  graph via `.with_config({"callbacks": [...]})`. On `on_tool_start` it looks
  up a per-app `TOOL_STATUS_MAP` (e.g. `graphs/unified_qa_assist/tool_status_map.py`:
  `"herodotus_aggregate": "Counting feedback by topic…"`) and pushes a
  `{"type": "tool_running", "status": ..., "tool": ..., "params": inputs}`
  event onto the LangGraph custom stream via `get_stream_writer()`; on
  `on_chat_model_start` it pushes a `{"type": "thinking", "status": "Thinking…"}`
  event. This is a clean, generic **UX progress-indicator pattern** completely
  decoupled from the graph's own state — it rides the LangGraph "custom" stream
  channel as a sidecar.
- **`_mig_content_shim.py`** — a host-side monkeypatch, imported (for its
  side effect) by every harness wrapper. It patches
  `iq_socrates_sdk...mig_interfaces._mig_format_messages` so that list/
  content-block message content (which DeepAgents accumulate after tool use)
  gets flattened to a string before being sent to the Model Inference Gateway
  — working around an SDK bug where only `SystemMessage` content was
  flattened, causing HTTP 400 on the *second* conversational turn. Idempotent
  (checks a module-level flag before patching).
- **`_provenance.py`** — trivial helper returning
  `{"graph_id", "harness_version", "skills_version"}` via
  `importlib.metadata.version(...)`, so every trace/log line is stamped with
  exactly which harness+skills package versions produced it.
- **Per-surface routing lives entirely in `config.configurable` + message
  content**, not in this repo. Per `docs/postman.md`:

  | Surface | `application` value | Tools |
  |---|---|---|
  | Dashboard chat (`unified_qa_assist` default) | `qualtrics-assist` | Herodotus |
  | Insight Explorer | `insight-explorer` | DFS + `herodotus_get_valid_text_ids` |
  | Frontline Recommended Actions | `frontline-recommended-actions` | LXH |

  Dashboard reads `conversation_context_id` purely from
  `config.configurable`; Insight Explorer/FRA need `application` +
  `fieldset_id`/`text_field_id` **duplicated into the message content itself**
  because those are LLM-supplied tool arguments, not injected context — a
  subtlety that has bitten real usage (500s when the model has to guess a
  placeholder ID).
- **Sandbox execution:** `unified_qa_assist`'s code interpreter runs
  server-side via a separate HTTP microservice
  (`coreml-model-engineering/code-interpreter`), authenticated by a shared JWT
  secret (`CODE_INTERPRETER_JWT_SECRET`), which itself owns the AWS Bedrock
  AgentCore credentials — i.e. the sandbox is **out-of-process**, not an
  in-graph subprocess/container.

Given the 6 generated graphs are truly identical modulo `GRAPH_NAME`, there is
effectively only **one graph-hosting pattern** across this entire repo's
"skills apps": *thin async-context-manager wrapper → build_harness_graph →
attach a progress-callback*. Everything that differentiates the six surfaces
(prompts, tool sets, routing, state) lives in the `qualtrics-agent-skills`
package as SKILL.md-like folders (this is the closest analog to CrystalOS's
own skill folders — see §9).

---

## 5. Custom Routes (`custom_routes/`)

Only one route today: **`GET /proactive-recommendations/{app_name}`** — static,
brand-keyed starter-question chips for a chat UI to show on open, with **zero
model/graph invocation** (reads a `questions.txt` file bundled inside the
installed `qualtrics_agent_skills` wheel).

Files:
- **`custom_routes/app.py`** — `from src.app import app` (the *base image's*
  FastAPI instance — `src/` only exists inside the built image, at
  `/deps/self-hosted-lang-graph-platform`, never in this repo's source tree)
  then appends a route to that same app object. The Dockerfile repoints the
  base image's `LANGGRAPH_HTTP` env var at `custom_routes/app.py:app` instead
  of the stock `src/app.py:app`, so **all** platform routes (`/threads`,
  `/runs`, etc.) plus this one custom route are served from a single app.
  - Auth is **in-handler**, not via the platform's global
    `enable_custom_route_auth` flag — deliberately, because that flag would
    also wrap SLGP's own custom routes (`/relocation`, `/brand-deletion`),
    which use different issuers/secrets. The handler calls the platform's own
    `src.jwt.decode_jwt`, then re-derives `urlHash` from the *actual* request
    path/query and checks it against the token's claim (replay/tampering
    protection), and checks `method` too:
    ```python
    def _authenticated_brand_id(request: Request) -> str:
        token = request.headers.get("x-jwt")
        decoded, _ = decode_jwt(token)
        brand_id = decoded.get("brandId")
        if decoded.get("method", "").upper() != request.method.upper():
            raise HTTPException(401, "JWT method does not match request method")
        if decoded.get("urlHash") != url_hash(request.url.path, request.url.query):
            raise HTTPException(401, "JWT urlHash does not match request path")
        return brand_id
    ```
- **`custom_routes/jwt_utils.py`** — `url_hash(path, query)` =
  `base64url(sha256(path[?query]))`, padding stripped — deliberately kept
  free of any `src` import so it's unit-testable outside the built image.
- **`custom_routes/recommendations.py`** — `get_recommendations(app_name,
  brand_id)`: resolves `<installed qualtrics_agent_skills pkg>/<app_name>/brands/
  <brand_id>/questions.txt`, falling back to `brands/default/questions.txt`,
  returning `[]` on any miss. Validates `app_name`/`brand_id` against
  `^[A-Za-z0-9_-]+$` before using them as path segments (defense against path
  traversal — both come from caller-controlled input: URL path and JWT claim).

**Local-dev caveat, explicitly called out in CLAUDE.md:** because
`custom_routes/app.py` imports `src.app` (image-only), `langgraph.json`
deliberately omits `http.app`, so this route is **not** testable under
`langgraph dev` — only via `task ci:image:build` + `docker run`. Testing is
therefore split: the `src`-free pure helpers (`jwt_utils.url_hash`,
`recommendations.get_recommendations`) are unit-tested directly; the full
route (import + wiring) is only exercised through an actual image build.

---

## 6. Config & Deployment

### `langgraph.json` / `langgraph.dev.json`

Both declare `dependencies: ["./"]`, `env: ".env"`, and an identical `graphs`
map (assistant_id → `./graphs/<name>/graph.py:graph`) for all 8 registered
graphs. The **only diff** is `langgraph.dev.json` adds:
```json
"auth": { "path": "graphs/dev_auth.py:auth" }
```
so `task dev`/`langgraph dev` authenticates locally via a small
`langgraph_sdk.Auth` handler (`graphs/dev_auth.py`) instead of the base
image's production middleware. `dev_auth.py`:
- Allowlists `/ok`, `/version` with no auth.
- HS256-verifies `X-JWT` against `PRIMARY_AUTH_TOKEN` if set; otherwise skips
  signature verification with a `warnings.warn` (explicitly flagged
  local-only-unsafe).
- Falls back to `DEFAULT_BRAND_ID`/`DEFAULT_USER_ID`/`DEFAULT_PRODUCT`/
  `DEFAULT_USER_TYPE` env vars for any missing JWT claim.
- Returns a `langgraph_sdk.Auth`-shaped identity dict
  (`identity`, `display_name`, `is_authenticated`, `permissions`, plus custom
  `brandId`/`userId`/`issuer`/`product`/`userType` keys).

Both `http.configurable_headers` blocks explicitly `include` `x-transaction-id`
/`x-parent-request-id` (so they flow into `config.configurable` for tracing)
and `exclude` `x-jwt`/`X-JWT` (so the raw JWT never leaks into run
config/traces). **In production this file is not read at all** — the
Dockerfile bakes an equivalent `LANGGRAPH_HTTP` env var directly, and
`LANGSERVE_GRAPHS` is derived from `langgraph.json` at *image build time* via
the Taskfile, not read at runtime.

### Two graph-authoring workflows (README "Adding or upgrading a graph")

1. **Skills apps (generated):** bump the `qualtrics-agent-skills` pin →
   `poetry lock` → `task graphs:generate` (regenerates wrappers +
   `langgraph.json` from the installed package) → commit. `task graphs:check`
   (also run in CI) fails the build if generation drifted from what's
   committed — a **drift gate**, not just a linter.
2. **Hand-written graphs (cx/ex):** bump the pin, manually add the
   `langgraph.json` entry + wrapper (modeled on the existing ones), **must**
   include the Galileo `enable_galileo_tracing(...)` block *before any
   LangChain import* or the SDK silently drops that graph's spans as
   "unregistered."

### `scripts/generate_graphs.py` — the codegen contract

This is the most interesting piece of tooling in the repo. It's a from-scratch
(no Jinja) template-string generator with a genuinely careful
**preserve/prune/never-silently-drop** algorithm:

- `discover_apps(skills_root)` — any top-level dir in the installed
  `qualtrics_agent_skills` package containing an `AGENTS.md` is "an app."
- Every generated `graph.py` carries `MARKER = "# @generated by
  scripts/generate_graphs.py — DO NOT EDIT"` on line 1 — used **only** to
  decide which directories the generator is *allowed to prune*, never to
  decide whether something *is* generated (that's always re-derived from the
  installed skills package, not from repo state) — this avoids ever
  mis-classifying a hand-written graph as generated even if it happened to be
  touched by an old generator run.
- `_build_graphs_mapping` — merges three sources into the final
  `langgraph.json["graphs"]`: (a) apps discovered from the skills package
  (always win), (b) on-disk dirs with no marker (hand-written, e.g. cx/ex —
  preserved verbatim), (c) any existing `langgraph.json` entry whose directory
  isn't even present on disk (e.g. a graph served from a *separately deployed*
  package) — so a regenerate can never silently orphan an entry it doesn't
  understand.
- `check()` (the CI drift gate) diffs the *planned* output against what's
  committed and prints a unified diff per drifted file plus any stale
  generated dir not yet pruned — actionable CI failure output, not just a bare
  exit code.
- Fully unit-tested in isolation (`tests/test_generate_graphs.py`) against a
  fabricated tmp skills-root + tmp graphs-tree — no dependency on the real
  installed package or network.

### `pyproject.toml` / `pip.conf` / Poetry

- Single internal Artifactory PyPI mirror
  (`artifactory.eng.qops.net/artifactory/api/pypi/pypi-virtual/simple`) as the
  **only** package source (`pip.conf` mirrors the same URL for pip-level
  installs, both without embedded credentials — trusted-host + a separate
  vault-mounted credential path, to dodge IaC secret-scanners).
- Every dependency version that must match the base image is called out with
  an inline comment explaining *why* (e.g. `langgraph-api = "==0.11.2"` —
  "poetry installs into the image's system site-packages, and a downgrade
  here breaks the image's `/storage langgraph_runtime_postgres`"). This is a
  recurring theme: **the base image dictates several pins**, and this repo's
  job is to track them, not choose them independently.
- Dev-only deps: `pytest`, `pytest-mock`, `pytest-cov`, `pytest-asyncio`,
  `mypy`, `ruff`, `langgraph-cli[inmem]`, `pre-commit`.
- One documented per-file ruff exception (`E402` for the ex wrapper's
  intentional import-order hack).

### `Dockerfile`

- `FROM registry-app.eng.qops.net:5001/socrates/langgraph_platform_base:CD-<timestamp>.<sha>-wolfi`
  — a **Wolfi** (Chainguard, glibc, continuously-patched) variant; the CLAUDE.md
  explains SIP publishes Debian+Wolfi twins of the same SHA so flipping tags is
  a one-line change provided the Dockerfile follows the "consumer contract"
  (`chown appuser`/`USER appuser`).
- Installs `bash` explicitly (Wolfi ships busybox `/bin/sh` only; a
  transitive lib calling `subprocess.run(["bash", "-c", ...])` would otherwise
  `FileNotFoundError`).
- Installs pinned lint/test tooling **globally** (matching `pyproject.toml`
  pins) so CI and local `poetry run` see identical tool versions.
- `poetry install --only main --no-root` into system site-packages
  (`POETRY_VIRTUALENVS_CREATE=false`), then uninstalls poetry itself and
  clears caches — classic slim-image hygiene.
- Copies `graphs/`, `custom_routes/`, `scripts/`, `langgraph.json(.dev)` into
  the image's `/deps/self-hosted-lang-graph-platform/` tree (matching the base
  image's expected working dir), then does `pip install -c
  /api/constraints.txt -e .` — editable install constrained against the base
  image's own dependency constraints file, so the consumer's deps can't
  silently diverge from what the base runtime was built/tested against.
- Explicitly restates `LANGGRAPH_HTTP` (pointing at
  `custom_routes/app.py:app`) **and re-declares the same
  `configurable_headers`** as `langgraph.json` — with a comment warning to
  keep the two in sync, since production reads the env var, not the JSON file.
- `ARG`/`ENV` for `LANGSERVE_GRAPHS_VALUE`, `GIT_COMMIT`, `DOCKER_CONTAINER_TAG`
  — build-time provenance baked into the running container.

### `Taskfile.yml` (CI tasks — go-task, not just Make)

Tasks seen: `default`, `install`, `lint`, `lint:fix`, `format`, `dev`,
`graphs:generate`, `graphs:check`, `clean`, `ci:image:build`, `ci:test`,
`ci:image:push`, `ci:git:tag`, `ci:spinnaker:trigger`, `ci` (full parity: lint
+ format-check + test). Notably `ci:git:tag` creates a `CD-<UTC
timestamp>.<short_sha>` git tag via the **GitLab Tags API** (not
`CI_JOB_TOKEN`, which can't create tags on their instance — a scoped Project
Access Token instead), and is designed to **degrade gracefully**: if the PAT
expires, tagging logs a warning and the pipeline **continues** (image publish
+ Spinnaker deploy aren't gated on the tag).

### Deployment pipeline

Push to `main` → GitLab CI builds+tests+publishes to Artifactory, tags the
commit, triggers Spinnaker: **Beta (b1-prv) → manual judgment → Gamma (g1-cmh)
→ manual judgment → Production (9 DCs incl. gov1)**. Scaling is **KEDA**
(CPU 50% / memory 85% utilization thresholds, 2–6 replicas, 60s poll/120s
cooldown, fallback to 3 replicas if metrics-server misbehaves 3 polls in a
row) — config lives in Helm `values.yaml`, explicitly documented as "our
team's responsibility post-split" vs. things still owned by the base image
(worker pool tuning, cluster capacity, cross-DC LB).

---

## 7. Testing Patterns

All 5 test files are **pure unit tests with zero real network/LLM calls** —
consistent with "the actual graph logic isn't here, so there's nothing to
integration-test at the node level." What's tested instead:

- **`test_generate_graphs.py`** — the codegen script against a fabricated
  tmp skills-root + tmp `graphs/` tree: discovery, template rendering,
  write/preserve/prune semantics, and the CI drift gate (`check()`), including
  edge cases like "an entry in `langgraph.json` whose directory isn't on
  disk must survive a regenerate."
- **`test_graph_wrappers.py`** — smoke tests per wrapper, **mocking**
  `tracing_context` and `Graph.get_compiled_graph`/`build_harness_graph`, to
  assert only the wrapper's own contract: correct `project_name`, correct
  metadata stamped into both the tracing context *and* `config["metadata"]`,
  existing metadata keys preserved (not clobbered), and trace headers
  (`x-transaction-id`/`x-parent-request-id`) promoted from `configurable` into
  metadata only when present (parametrized across `unified_qa_assist`,
  `unified_aipc`, `project_assist` to prove the shared template behaves
  identically for all three).
- **`test_jwt_utils.py`** — `url_hash` reimplemented independently in the test
  (`_expected`) and compared byte-for-byte, plus a format assertion (43 chars,
  no `=`, base64url alphabet only) to guard against an accidental switch to
  hex encoding.
- **`test_recommendations.py`** — brand override vs. default fallback,
  blank-line skipping, **path-traversal rejection** parametrized over
  `["../etc", "a/b", "..", "app name", ""]`, missing-package handling.
- **`test_tool_status_callback.py`** — asserts the exact SSE-shaped dict
  emitted per tool-start event, that no-arg tools omit `params` (not an empty
  dict), that unmapped tools emit nothing, and that a missing/broken stream
  writer doesn't blow up the tool call (`RuntimeError` swallowed).

**Testing philosophy embodied here:** test the *thing this repo actually
owns* (wrapper contracts, codegen fidelity, small pure functions) with fast,
fully-mocked unit tests; explicitly punt anything that needs the built image
or upstream packages to either (a) the image-build CI stage
(`task ci:image:build` + docker run) or (b) the upstream package's own test
suite (README calls out "Heavier integration tests ... live in the
source-repo packages ... they aren't wired into the deploy gate"). Nothing
here resembles an "eval"-style LLM-output test — that responsibility lives
entirely upstream too.

---

## 8. Notable Design Decisions

1. **Radical thinness as an intentional architecture, not a stub.** The repo's
   own docs are explicit that this is temporary infrastructure glue, and go to
   real lengths (codegen + drift gate, `@generated` markers, "never edit a
   generated wrapper") to keep the wrapper layer from ever accidentally
   growing custom logic that belongs upstream.
2. **Import-order is treated as a first-class hazard, not an implementation
   detail.** Two separate, carefully-commented workarounds
   (Galileo-before-LangChain, tiktoken-shim-before-ex-package) exist purely
   because Python's "first import wins" instrumentation/monkeypatch semantics
   are load-bearing. Both are guarded by tests or explicit "don't touch"
   CLAUDE.md callouts.
3. **Fail-open on observability, fail-loud on auth.** Every tracing
   integration (Galileo, LangSmith via `tracing_context`) is wrapped in
   try/except with a warning log — tracing must never take down the pod. Auth
   (`X-JWT` verification, `urlHash`/`method` binding) has no such fallback —
   it 401s hard.
4. **Stricter base image = latent single-point-of-failure risk, explicitly
   documented.** Since langgraph-api 0.9.0, *all* graphs are collected eagerly
   at startup and one graph failing to construct **hard-fails the whole pod**
   (older versions degraded per-graph). CLAUDE.md flags this as a reason to
   prefer lazy model construction in new graphs — a real production
   post-mortem lesson baked into guidance, not discovered by trial and error
   each time.
5. **Provenance is stamped everywhere, cheaply.** `_provenance.py`'s
   `importlib.metadata.version(...)` pattern means every trace/log for the six
   skills-apps carries exact `harness_version`/`skills_version` — critical
   when six "graphs" are really one shared package's behavior, so any given
   trace can be tied back to precisely which release produced it.
6. **Auth binds the JWT to `(method, path)`, not just brand/user identity** —
   both in the base image's own middleware and in the hand-rolled
   `custom_routes` auth. A token minted for one endpoint literally cannot be
   replayed against another, even by the same authenticated caller.
7. **Everything that could silently drift is CI-gated, not just documented.**
   Codegen drift (`graphs:check`), lint/format (`ci:lint`/`ci:format`), and
   image-build-time constraint pinning (`-c /api/constraints.txt`) all fail
   the pipeline rather than relying on a human noticing.

---

## 9. Direct Comparisons to CrystalOS

CrystalOS (per `crystalos/CLAUDE.md`, `crystalos/lib/skill_runtime.py`,
`crystalos/agents/crystal.py`, `crystalos/graphs/insights.py`) is **not**
"skill-runtime instead of LangGraph" — it's actually a **hybrid that CLS's
architecture doesn't have to reason about at all**, because CLS never owns
graph internals:

- `crystalos/graphs/insights.py` **is** a real `langgraph.graph.StateGraph`
  (18 nodes, one explicit fan-out/fan-in: `embed → {metrics, extract_texts} →
  absa`, a `TypedDict` state (`InsightState`, ~45 fields) threaded through the
  whole pipeline) — directly analogous to what `cx_agent_qa_graph`/
  `ex_agent_qa_graph` must look like *upstream*, in the packages CLS imports
  but doesn't contain.
- `crystalos/lib/skill_runtime.py` + `crystalos/agents/crystal.py`'s
  skill-first path (`SkillRuntime.execute()`, semantic routing via
  `skill_registry.find`, EVALS.md-driven quality gating, retry-with-context)
  is CrystalOS's own analog of the **`qualtrics-agent-harness` +
  `qualtrics-agent-skills` DeepAgent layer** that CLS's six generated wrappers
  call into — except CrystalOS built this itself in-house (custom skill
  runtime + custom EVALS.md parser + custom example-bank), where CLS's
  organization outsourced the equivalent (harness + skills as a *separately
  versioned, separately deployed* package pair).

| Axis | `cme-langgraph-service` (+ upstream packages) | CrystalOS |
|---|---|---|
| **Graph engine** | LangGraph, but the actual `StateGraph`/nodes live in externally versioned packages this repo only pins & imports | LangGraph in-repo (`graphs/insights.py`, `graphs/custom_analysis.py`) — nodes, edges, and `InsightState` TypedDict are first-class, directly editable, checked into the same repo as the calling code |
| **Skill/agent-reasoning layer** | `qualtrics-agent-harness` (DeepAgents) + `qualtrics-agent-skills` — a separate published package pair; this repo only calls `build_harness_graph(app_name)` | `SkillRuntime` (`lib/skill_runtime.py`) + skill folders (`skills/<name>/{SKILL.md,EVALS.md,EXAMPLES.md}`) — fully in-repo, hand-rolled quality gate (structural + LLM-judge hybrid), retry-on-eval-failure, example-bank write-back |
| **Deployment/serving shape** | One shared multi-tenant PaaS base image (SLGP) that many unrelated teams' "consumer services" ride; this repo owns only wrappers + config | Single FastAPI service (`crystalos/main.py`) that *is* the whole product's agent layer — no shared base-image abstraction, no separate consumer-service split |
| **Versioning of "graph logic" vs. "serving shell"** | Deliberately decoupled: bump a pin, `poetry lock`, redeploy — graph logic ships on its own package's release cadence, independent of this repo's deploy cadence | Coupled: a graph/node/skill change is a commit in the same repo, same deploy, same version as everything else |
| **Multiple graphs, one topology template** | 6 of 8 graphs are the *literal same generated wrapper*, differentiated only by which skills-package sub-app they load (config-driven fan-out from one harness factory) | Insight pipeline is one graph (`insights.py`); `custom_analysis.py` is a **separate, deliberately isolated** graph reusing shared tool functions but with its own linear flow + hard invariants (never writes `insights` table, no predictive layer) — closer to "one codebase, a few distinct hand-tuned graphs" than "one template, many configs" |
| **State schema location/visibility** | Not in this repo at all (upstream `state.py` per package) — a caller onboarding onto a new graph has to read `docs/caller-onboarding.md`'s informally-documented `input` shape, or go read the upstream package | Fully visible, single source of truth: `InsightState` TypedDict in `graphs/insights.py`, `CrystalInput`/`CrystalOutput`/`ActionProposal` Pydantic models in `agents/crystal.py` |
| **Action-proposal / propose-not-execute boundary** | No direct analog — CLS's graphs actually execute their own logic end-to-end (query→retrieve→respond); there's no "propose a mutation, let the caller confirm" pattern visible here | Central architectural invariant: `ActionProposal` (`agents/crystal.py`), `_normalize_proposal`/`_PROPOSAL_TYPE_ALIASES`, "Crystal proposes, Copilot/endpoints execute" — CrystalOS's core safety boundary that CLS's domain doesn't need (CLS's CX/EX/assist graphs are read-only Q&A, not mutation-adjacent) |
| **Auth model** | JWT (HS256) bound to `(method, urlHash, brandId, userId)`, verified by the shared base image + duplicated in-handler for custom routes | `X-Internal-Key`/`AGENTS_INTERNAL_KEY` shared secret between Node backend and CrystalOS (`require_internal_key`), plus per-request `org_id`/permission resolution (`BrandContext`, `ROLE_PERMISSIONS`) — a materially simpler trust model (one internal caller: the Node backend) vs. CLS's "many internal service callers, replay-proof per-request JWTs" |
| **Tracing/observability** | Two parallel systems wired per-graph: LangSmith (`tracing_context`, per-graph project) + Galileo (SQS-based OTel ingestion, per-graph logstream, gated by env var, stage-only today) | Langfuse (`lib/tracer.get_tracer().log_generation(...)`), used ad hoc inside `crystal.py`/`skill_runtime.py` call sites, not wired as a graph-wide callback/instrumentation layer |
| **Progress-streaming to the client** | `ToolStatusCallbackHandler` — generic LangChain callback attached via `.with_config({"callbacks": [...]})`, driven by a static per-app `TOOL_STATUS_MAP` dict, pushed via `get_stream_writer()` | SSE events assembled ad hoc inside `agents/crystal.py`'s `_react_plan_tools` generator (`yield ("event", {...})`) — hand-written per call site rather than a reusable callback class |
| **Codegen / drift-gating** | `scripts/generate_graphs.py` + `task graphs:check` in CI — a hard gate that generated wrapper code never diverges from what the skills package would produce | No direct analog — CrystalOS has no generated-code layer; closest is skill auto-registration (`registry.initialize()` at startup discovers `skills/<name>/` folders — no codegen, just runtime discovery) |

---

## 10. Patterns Worth Adopting

Ranked roughly by leverage-to-effort for CrystalOS:

1. **The `_tool_status_callback.py` pattern (highest leverage, lowest
   effort).** A single generic `AsyncCallbackHandler`, parameterized by a
   `dict[tool_name, status_text]`, attached once via `.with_config({...})`,
   emitting `{"type": "tool_running"/"thinking", ...}` onto the stream. This
   is strictly more reusable than CrystalOS's current approach of hand-writing
   `yield ("event", {...})` calls inline inside `_react_plan_tools` — a
   callback class would decouple "what UI text does tool X show" from "the
   loop that runs tools," and make it trivial to add a new surface-specific
   status map without touching the loop itself.
2. **Provenance stamping via `importlib.metadata.version(...)`.** CrystalOS
   already tracks skill/eval versions informally (`skill_version` fields in
   `SkillResult`), but CLS's `_provenance.py` pattern of pulling the *installed
   package version* at runtime and stamping it onto every trace/log line is a
   cheap, high-value addition wherever CrystalOS's skill runtime currently
   only logs `skill_name`/`skill_version` from the skill's own metadata dict —
   doing the same for the CrystalOS package itself (or the skills bundle, if
   it's ever split into a separate package) would make incident correlation
   ("which CrystalOS release produced this bad answer") immediate.
3. **CI drift-gating for anything generated or templated.** CrystalOS doesn't
   generate code today, but if skill scaffolding, tool-registry entries, or
   `TEAM.md`/`SKILLS.md` boilerplate is ever templated (per the project's own
   "Team-driven Implementation Protocol"), CLS's `--write`/`--check` dual-mode
   script + "never hand-edit, marker-gated prune" discipline is a proven
   template worth copying directly (including the drift-diagnostic unified
   diff output).
4. **Import-order/monkeypatch documentation discipline.** CrystalOS's own
   CLAUDE.md already has a "Things to avoid" style section; CLS's practice of
   pairing every fragile ordering hack (Galileo-before-LangChain, tiktoken
   shim) with (a) a code comment explaining *why*, (b) a CLAUDE.md "don't
   touch this" callout, and (c) in one case a dedicated ruff per-file-ignore,
   is a good template for CrystalOS's own known-fragile spots (e.g. the MIG
   client's model construction, or any place import order currently matters).
5. **Fail-open observability / fail-loud auth as an explicit written
   convention.** Worth stating as an explicit CrystalOS rule (it's implicit
   today) — every tracing/telemetry call should be try/except-wrapped with a
   log-and-continue, while every auth/permission check should raise.
   CrystalOS's `_fire_telemetry` already does fire-and-forget correctly; making
   the "never let observability crash a request" rule explicit (as CLS's
   CLAUDE.md does) would guard future contributors from tightening error
   handling in the wrong direction.
6. **Explicit separate-package boundary as an *option*, not obligation.** CLS's
   split of "harness+skills" into an independently-versioned package that
   multiple consumer graphs import is worth knowing about as a scaling pattern
   *if* CrystalOS's skill runtime is ever reused by a second product/service
   outside Xperiq's own backend — but given CrystalOS today is a single
   product's single service, forcing this split prematurely would trade
   CrystalOS's current advantage (single-repo, single-deploy, everything
   versioned together) for CLS's advantage (independent release cadence) it
   doesn't currently need.

---

## 11. Open Questions / Gaps

- **This checkout cannot answer the "core payload" ask literally.** The task
  asked for node-by-node/state-by-state graph breakdowns, but 6 of 8 graphs
  have zero node/state code in this repo (harness-built), and the other 2
  reference upstream packages (`cx-agent-qa-graphs`, `ex-agent-qa-graphs`) not
  present in this checkout. To get real node/edge/state detail for cx/ex or
  the harness's actual DeepAgent graph, the upstream repos
  (`coreml-model-engineering/cme-graphs/cx-agent-qa-graph`,
  `.../ex-agent-qa-graph`, `.../qualtrics-agent-harness`,
  `.../qualtrics-agent-skills`) would need to be cloned and read directly —
  none of that source is reachable from this repo alone.
- **README.md is stale relative to `langgraph.json`.** The README's
  architecture section and "Hosted graphs" table describe only 3 graphs
  (`cx_agent_qa_graph`, `ex_agent_qa_graph`, `unified_qa_assist`); the actual
  `langgraph.json` registers 8 (adding `frontline_recommended_actions`,
  `insight_explorer`, `project_assist`, `unified_aipc`, `unified_qa_ex`). This
  is worth flagging to the CLS team but is out of scope to fix here — it does
  mean any narrative pulled from the README about "what this service hosts"
  under-counts by 5 graphs; `docs/caller-onboarding.md`'s table is equally
  stale.
- **No visibility into per-brand skill content.** `docs/proactive-
  recommendations.md` explicitly defers "curating the questions themselves"
  to the `qualtrics-agent-skills` repo — another example of real behavior
  living entirely upstream.
- **Galileo tracing is stage-only (b1-prv) today** — prod Galileo queues don't
  exist yet per-DC, so the "observability parity across environments" story
  is incomplete; not an issue for porting patterns, but worth knowing if
  someone assumes CLS has full-prod LLM-trace coverage.
- **The generated wrapper template hard-codes `backend = "agentcore"`
  assumptions** (the `asyncio.to_thread` comment references Code Interpreter +
  JWT signer setup) inside a comment, but the actual backend selection logic
  isn't visible in this repo — another upstream-package concern.
