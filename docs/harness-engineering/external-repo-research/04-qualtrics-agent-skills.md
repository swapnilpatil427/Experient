# qualtrics-agent-skills — Deep Dive

Target repo: `/Users/spatil/Documents/Projects/InsightExplorerV2/qualtrics-agent-skills`
Sibling framework repo (not in this checkout, referenced only): `qualtrics-agent-harness` ("QAH"), consumed at runtime by `cme-langgraph-service` ("CLS").

This document is a from-source deep dive (every file read in full unless noted) intended to inform a port of this repo's skill-authoring conventions into CrystalOS (`crystalos/lib/skill_runtime.py` + `crystalos/lib/skill_registry.py`, skills as `SKILL.md` + `EVALS.md`).

---

## 1. Overview & Purpose

`qualtrics-agent-skills` (QAS) is explicitly **not** an agent runtime — its own README says it plainly:

> This repo holds the *skills* half of the harness↔skills separation. It carries **no harness code** — it is a packaged data carrier.

The three-repo stack it belongs to (from `docs/adding-an-app.md`):

```
qualtrics-agent-skills  (content)   →  your app folder: AGENTS.md + deepagents.toml + skills/
qualtrics-agent-harness (the engine) →  builds a DeepAgent from your folder; owns tools + backends
cme-langgraph-service   (the runtime) →  pins both wheels, serves your app as a graph over REST
```

- QAS is a **pure-data Python package** (a "wheel of markdown/TOML/JSON"). Its own `pyproject.toml` docstring: *"This package is a DATA CARRIER: each app folder ships its AGENTS.md, deepagents.toml, skills/<name>/SKILL.md, and brands/<brand>/questions.txt as read-only assets inside the wheel."*
- The harness (QAH, sibling repo, not present in this checkout) is built on **deepagents** — LangChain's/LangGraph's "Deep Agents" framework — and specifically its `SkillsMiddleware`, which does **progressive disclosure**: only a skill's `name` + `description` (YAML frontmatter) enter the system prompt; the full `SKILL.md` body is read on demand by the agent via a `read_file` tool call.
- CLS (`cme-langgraph-service`) is the LangGraph-serving runtime — it pins a version of both QAS and QAH, generates a `graph.py` + `langgraph.json` entry per app, and exposes each app as a JWT-gated REST graph (`assistant_id = <app_name>`).
- Versioning is decoupled: *"skills version independently of the harness — change skills, bump this package, no harness rebuild."* The harness resolves an app folder at runtime via `importlib.resources.files("qualtrics_agent_skills") / <app_name>`.

**Backends.** Each app picks a `backend` in `deepagents.toml`:
- `filesystem` (default) — skills are read from the installed package; no code execution.
- `agentcore` — skills can *run* code via a code-interpreter sandbox VM (AWS-backed, reached over an HTTP service, JWT-signed). Every current app in this repo uses `agentcore`.

**Current apps** (6 top-level folders under `qualtrics_agent_skills/`), each one product surface / one DeepAgent:

| App | Purpose | Backend | Model |
|---|---|---|---|
| `unified_qa_assist` | Qualtrics CX analysis assistant (themes, sentiment, verbatims, driver analysis, report generation) — serves 3 surfaces: `qualtrics-assist`, `insight-explorer`, `frontline-recommended-actions` | agentcore | bedrock-claude-v5-sonnet |
| `insight_explorer` | Structured fieldset-level reports (headlines/summary/full-insights) — thin wrapper, defers to `unified_qa_assist`'s skills for the actual work in practice (its own `AGENTS.md` is empty) | agentcore | bedrock-claude-v5-sonnet |
| `frontline_recommended_actions` | Location/store-level AI insights + recommended actions (LXH service) | agentcore | bedrock-claude-v5-sonnet |
| `unified_qa_ex` | Employee-experience (EX) survey analysis — pre-aggregated widget data | agentcore | bedrock-claude-v5-sonnet |
| `project_assist` | Creates a brand-new research survey from scratch, output = validated Pydantic JSON | agentcore | bedrock-claude-v46-sonnet-non-prod |
| `unified_aipc` | "AI Product Companion" — full survey builder: create / edit / recommend (logic + AI features) / save / load, with markdown↔JSON↔QSF conversion | agentcore | bedrock-claude-v5-sonnet-non-prod |

Three of the six apps (`insight_explorer`, `frontline_recommended_actions`, `unified_qa_ex`) ship an **empty `AGENTS.md`** — their skills carry the entire operating logic and the app-level system prompt is unused/vestigial for those surfaces (`unified_qa_assist`'s `AGENTS.md` appears to be the "real" shared brain that several surfaces route through via the `application` field in injected context).

---

## 2. Repo-level tooling

- **`pyproject.toml`** — Poetry project, Python `>=3.11,<3.15`. `packages = [{include = "qualtrics_agent_skills"}]` with an explicit `include` allow-list shipping `**/*.md`, `**/*.toml`, `**/*.txt`, `**/*.py` into both sdist and wheel — i.e. every asset type a skill can be made of. Custom Artifactory PyPI source. Dev-only deps: the harness itself (`qualtrics-agent-harness>=0.8,<1.0`, for local Studio + `check_app_construction.py`), `langgraph-cli`, `pydantic`, `pytest`/`pytest-asyncio`, `pyyaml`, `python-dotenv`. An optional `redteam` dependency group pulls `agent-persona-hub` from a private GitLab repo for adversarial evals. A `pytest.ini_options` marker `eval` isolates LLM-cost evals from normal CI.
- **`langgraph.json`** — maps 3 of the 6 apps (`project_assist`, `unified_qa_assist`, `unified_aipc`) to local dev entrypoints under `dev/*.py:graph` for LangGraph Studio. `insight_explorer`, `frontline_recommended_actions`, `unified_qa_ex` have no Studio entrypoint registered (only usable through CLS).
- **`pip.conf` / `poetry.toml`** — pin the internal Artifactory PyPI mirror as the only index; `poetry.toml` also forces `virtualenvs.create = true`.
- **`Makefile`** — the single entry point for everything: `install`, `dev` (LangGraph Studio), `validate`, `check-construction`, `build`/`test`/`publish` (Dockerized), `eval`/`eval-report`/`export-traces`/`view-trace` (the eval harness, parameterized by `APP=`, `APPLICATION=`, `DATASET=`, `CASE=`, `REFRESH=`), and `redteam`/`redteam-scores`/`redteam-inspect-view` (adversarial evals via `agent-persona-hub`, gated on a live agent + optional dep group).
- **`script/docker/Dockerfile`** — Debian-slim Python 3.13 base image, installs Poetry, non-root `appuser`; since this is a pure-data package, `poetry install --no-root` is essentially a no-op besides tooling.
- **`script/docker/test.sh`** — runs inside the build image: asserts the version isn't already published (`pip index versions`), runs `validate_skills.py` + `check_app_construction.py`, and (if `DO_PUBLISH`) asserts the git branch is clean before allowing a publish.
- **`script/docker/publish.sh`** — `poetry build` + `poetry publish --repository qualtrics`.
- **`script/build.sh`** — the CI/local orchestrator: builds the Docker image, runs `test.sh` inside it, and (with `--publish` + `ARTIFACTORY_CREDS`) runs `publish.sh` inside it too.
- **`.jenkins/JenkinsfileMR` / `JenkinsfilePublish`** — not read in detail, but per README: MR pipeline runs `make validate` + `make check-construction`; merge-to-main pipeline additionally builds + publishes a versioned wheel.

---

## 3. Skill Authoring Convention — the shape every skill follows

### 3.1 Directory layout (from README + `docs/adding-an-app.md`)

```
qualtrics_agent_skills/
  <app_name>/                     # one folder = one product surface = one DeepAgent
    AGENTS.md                     # the agent's system prompt (scope, principles, dispatch table)
    deepagents.toml                # the APP CONTRACT — model, backend, native tool allow-list
    skills/
      <skill-name>/
        SKILL.md                   # YAML frontmatter (name, description, ...) + markdown workflow body
        scripts/                   # optional: helper .py run via the `execute` sandbox tool
        references/                # optional: extra markdown loaded by the skill body on demand
        models/                    # optional: Pydantic source-of-truth schemas (seen in project_assist)
        meta/                      # optional: static reference data (JSON templates, locator docs)
    brands/                        # optional: per-brand proactive-recommendation starter questions
      default/questions.txt
      <brand_id>/questions.txt
```

A skill can also be nested one level deeper as an **orchestrator + sub-skills** pattern (seen in `unified_aipc/skills/survey-builder/`):

```
skills/survey-builder/
  SKILL.md            # the router/orchestrator — routes intent to one of 3 sub-skills
  create/SKILL.md      # sub-skill: build from scratch
  edit/SKILL.md         # sub-skill: targeted edits
  recommend/SKILL.md    # sub-skill: logic/AI-feature audit + IR-based compiler workflow
  meta/                 # shared reference data (locators.md, logic.md, survey_template.json)
  reference/            # shared markdown references used by all 3 sub-skills
  scripts/              # shared Python: compile_logic.py, md_to_json.py, json_to_qualtrics.py
```

There is **no manifest file per app** beyond `deepagents.toml` — the app's identity, model, and native-tool allow-list live there; everything about *what the agent can do* lives in `AGENTS.md` (prose) + the `skills/` tree (frontmatter + markdown).

### 3.2 `deepagents.toml` — the app contract

```toml
[agent]
name = "unified_qa_assist"
description = "Qualtrics CX analysis assistant: themes, sentiment, verbatim comments, and reporting..."
model = "bedrock-claude-v5-sonnet"
backend = "agentcore"

[tools]
requires = [
    "herodotus_get_page_filters",
    "herodotus_aggregate",
    "dfs_search_comments",
    "trend_insights_analysis",
    # ... native tool names, resolved by the harness's tool_registry.py
]

[mig]
brand_id = "unified_qa_assist"
issuer = "unified_qa_assist"
prompt_caching = {cache_system = true}
```

Contract rules enforced by `script/validate_skills.py` (a Pydantic model, `_AgentConfig`/`_ToolsConfig`/`_MigConfig`):
- `[agent].model` — required, non-empty string.
- `[agent].backend` — must be `"agentcore"` or `"filesystem"` (a `Literal`).
- `[tools].requires` — a list of non-empty strings (native tool names resolved against the harness's own registry — **not** validated here, only structurally).
- At least one `skills/<name>/SKILL.md` must exist with `name` + `description` frontmatter.

Built-in sandbox/filesystem tools (`read_file`, `write_file`, `glob`, `execute`, `write_todos`) come free with the backend — they are referenced in a skill's own `allowed-tools`, never listed in `[tools].requires`.

### 3.3 `SKILL.md` — the atomic unit

Minimal real example (`project_assist/skills/survey-creation/SKILL.md` frontmatter):

```markdown
---
name: survey-creation
description: Create a professional research survey from scratch. Use this skill whenever a user wants a new survey they don't yet have — casual phrasings like "write me a survey about X", ...
allowed-tools: read_file, write_file, edit_file, glob, execute
---

# Survey Creation
...
```

Frontmatter fields observed across the corpus (no single skill uses all of them):
- `name` (required) — matches the directory name in every case observed.
- `description` (required) — the **only** thing that enters the system prompt besides `name`. Every SKILL.md in this repo writes it as a dense, trigger-phrase-rich paragraph ("Use this skill whenever...", explicit example utterances) because it is literally the router: the agent decides whether to open the file based on this string alone.
- `allowed-tools` — space/comma list scoping which tools this skill may call. Enforced narratively (the harness presumably also enforces this at the tool-call level, though that logic lives in QAH, not this repo).
- `compatibility` — seen as `opencode` on several skills (a hint to the harness/tooling about the target agent surface — meaning not deeply documented in this repo).
- `related-skills` — cross-reference hint (e.g. `frontline-recommended-actions` → `fra-formatting`).
- `license` — seen once (`survey-builder/SKILL.md`: `license: MIT`) — vestigial/inconsistent, not load-bearing.

**Body** is unstructured markdown — no enforced schema — but a strong repo-wide convention emerges:
- **Phased workflows** (`## Phase 1 — ...`, `## Phase 2 — ...`) with explicit stop/wait checkpoints for human-in-the-loop approval (survey-creation's outline checkpoint; survey-builder/recommend's dry-run-then-gate pattern).
- **Explicit tool-call recipes** — exact commands to run via the `execute` sandbox tool, with literal paths (`python3 /tmp/workspace/skills/<name>/scripts/<x>.py ...`), because the model is instructed to read this once and mechanically follow it rather than improvise.
- **"Never do X" / constraint call-outs** at the top of the body (e.g. `driver-analysis`'s `> **CONSTRAINTS**` block: never call `execute`, never call certain tools, never debug/retry).
- **A `<report>...</report>` XML delimiter contract** for surfaces that render a file-backed deliverable inline (`report-generation`, `ie-formatting`, `fra-formatting` all repeat an almost-identical "Return the inline report" section — this is a **UI integration contract**, not a formatting nicety: the frontend parses on the literal tags).
- **Cross-skill handoff instructions** — a skill explicitly says which other skill's `SKILL.md` to read next and what to pass it (e.g. `comment-analysis` → `ie-formatting`; `nlf-skill` → `driver-analysis`).

### 3.4 Skill-adjacent assets

- **`scripts/`** — pre-authored Python uploaded into the sandbox VM at session start under `/tmp/workspace/skills/<name>/...`; the model calls them via the `execute` tool rather than writing new Python per request. This is a recurring, explicitly-stated rule: *"Do not write new Python scripts... The fixed guardrail pipeline... is infrastructure only; agents must not author new `.py` files."* Two flavors observed:
  - **Deterministic parsers/compilers** with zero LLM involvement (`md_to_json.py`, `json_to_qualtrics.py`, `compile_logic.py` in `unified_aipc`) — pure stdlib + pydantic, designed to run identically every time. `compile_logic.py` is a small **IR (intermediate representation) → Qualtrics-JSON compiler**: the agent emits a structured JSON tree naming atomic predicates (`{"op": "promoter", "qid": "QID1"}`), and 100% of the boolean-algebra/locator-selection/JSON-shape work happens in deterministic Python, specifically to "keep token use minimal: the agent only does the fuzzy step (NL → IR) and the rest is pure code."
  - **Guardrail pipelines built on Pydantic models** (`project_assist/skills/survey-creation/{models,scripts}`) — `models/base.py` defines `StrictBaseModel` (`extra="forbid"`) and an `ExcludeFromLLM`/`LLMFilteredModel` pair that hides internal fields (e.g. Qualtrics certified-question metadata) from both the JSON schema shown to the model and from `.llm_dump()` output. `scripts/print_schema.py` prints `model_json_schema()` on demand so **there is no hand-maintained schema doc to drift** — the SKILL.md explicitly says so. `scripts/survey_pipeline.py` implements `ensure_unique_question_ids` → `prune_invalid_logic` → `renumber_question_ids` as three separate, individually-testable passes chained by `finalize_survey()`.
- **`references/`** — extra markdown the skill body tells the agent to read "one phase at a time" (progressive disclosure *within* a skill, not just across skills) — e.g. `project_assist/skills/survey-creation/references/{outline_planning,screener_planning,survey_critique,...}.md`, or `unified_qa_assist/skills/nlf-skill/filters.md` (a full analytics-engine filter-operator reference table, kept out of the main SKILL.md body to save prompt tokens on requests that don't need it).
- **`meta/`** — static reference data that isn't phase-specific, e.g. `unified_aipc/skills/survey-builder/meta/{locators.md, logic.md, survey_template.json}` (Qualtrics locator/logic-JSON syntax references) — loaded when the `recommend` sub-skill needs the exact `BooleanExpression` JSON shape.
- **`brands/<brand_id>/questions.txt`** — a completely separate, optional mechanism: one starter question per line, resolved by a *different* service (the `cme-langgraph-service` proactive-recommendations endpoint) for the pre-chat UI, falling back to `brands/default/questions.txt`. Not read by the agent itself at all.

### 3.5 Cross-cutting conventions worth naming explicitly

1. **Progressive disclosure at two levels** — (a) across skills (only `name`+`description` in the system prompt; full body read via `read_file` on demand) and (b) within a skill (references/meta loaded only for the relevant phase).
2. **Retrieval/analysis/formatting separation as a skill boundary.** `nlf-skill` (retrieve only, never interprets) → `comment-analysis`/`driver-analysis` (analyze only) → `ie-formatting`/`fra-formatting`/`report-generation` (format only). Each skill's frontmatter description states this boundary explicitly ("Application layer only; data retrieval is owned by `nlf-skill`").
3. **Propose → approve, never silent-apply.** Repeated verbatim across `unified_aipc`'s three sub-skills and `project_assist`: any edit to existing content is shown to the user and applied only on explicit confirmation.
4. **Confidentiality boilerplate.** Nearly every `AGENTS.md` repeats an identical "That's confidential — I'm not able to share details regarding my internal configuration" refusal line — a standing instruction, not a skill.
5. **Tool error policy boilerplate.** Also repeated near-verbatim: retry once, then stop and report rather than trying workarounds — explicitly to avoid wasted context on a backend that's already failing.

---

## 4. Full Skill Catalog

### `unified_qa_assist` (4 skills — the richest app)

| Skill | Purpose | Allowed tools | Notable details |
|---|---|---|---|
| `nlf-skill` | Natural-language → CX data query. Owns retrieval + filter-tree construction for both Herodotus (dashboard/QA surface) and DFS (fieldset/IE surface). Never interprets/summarizes. | `herodotus_*`, `dfs_*`, `write_todos` | Branches on injected `application` (`qualtrics-assist` vs `insight-explorer`) or on caller identity (`driver-analysis` forces a DFS-only path). Carries a large embedded reference on AE filter-operator semantics (types, operators, OXM multi-dataset topology, topic/sentiment field-ID derivation rules) plus a sibling `filters.md` for the exhaustive operator table. |
| `comment-analysis` | Shape the answer for the active surface (counts, themes, sentiment, quotes, conversational or structured-report) after `nlf-skill` has retrieved. | `read_file, write_file, write_todos, glob, execute` | Enforces "verbatim only" quote rules, intra-theme dedup, a **quote-count-to-theme-count ratio gate** for full IE reports (≥2× quotes per kept theme), and a documented fallback (drop to `SUMMARY` template) when coverage is too sparse. Hands off to `ie-formatting` for the IE surface. |
| `driver-analysis` | Topic-sentiment driver/differential analysis via `trend_insights_analysis`. | `trend_insights_analysis` only | Explicit **negative constraints** at top of file ("Never call `execute`", "Never call `dfs_aggregate`"). A worked decision procedure classifies standard-vs-differential analysis from user wording ("change"/"delta" language, not date count). Documents exact error-handling policy: always surface `trend_insights_analysis`'s own `accepted`/`truncated`/error fields verbatim rather than retrying. |
| `report-generation` | Synthesize prior in-conversation analyses into one deliverable (`CONVERSION`/`EXECUTIVE_SUMMARY`/`FULL_REPORT` templates). Never fetches new data. | `read_file, glob` | The canonical `<report>...</report>` UI-integration contract (see §3.3) is defined here first; other formatting skills copy it verbatim. |

Evals for this app also cover `insight-explorer` and `report-generation` cases (see §6) — i.e. `unified_qa_assist`'s skill set is the shared engine other "thin" apps route into via `application` context, even though each has its own `deepagents.toml`.

### `insight_explorer` (1 skill)

| Skill | Purpose | Allowed tools | Notable details |
|---|---|---|---|
| `ie-formatting` | Output templates for Insight Explorer structured reports (`HEADLINES_WITH_SUMMARY`, `FULL_INSIGHTS_WITH_SUMMARY`, `SUMMARY`). | `write_file, execute` | Ships a bundled **validator script** (`scripts/ie_validator.py`) that programmatically re-checks the agent's own draft: summary word count, theme/quote-count thresholds, a cherry-pick algorithm that drops the sparsest themes until a 2:1 quote:theme ratio holds (floor of 3 themes), and a **prevalence-label consistency check** (a numeric % must map to the correct canonical label via a fixed threshold table). This is a full write→validate→fix→re-validate loop driven from inside the SKILL.md, not just prompting. |

### `frontline_recommended_actions` (2 skills)

| Skill | Purpose | Allowed tools | Notable details |
|---|---|---|---|
| `frontline-recommended-actions` | Retrieve + present AI-generated location/store insights from the LXH service. | `lxh_get_configurations, lxh_get_subjects, lxh_search_insights` | Notable non-obvious business rule: each LXH configuration carries its own `ownerId`, which **must** be substituted for the authenticated user's own id in all downstream calls — a subtle identity-remapping rule that would be easy to get wrong. |
| `fra-formatting` | `FULL_LOCATION` / `SINGLE_INSIGHT` report templates for a location manager audience. | `write_file` | Mandates exact, deterministic save-path patterns (`fra-full-<subject_id>-<date>.md`) so the file always lands somewhere predictable regardless of model creativity. |

### `unified_qa_ex` (1 skill)

| Skill | Purpose | Allowed tools | Notable details |
|---|---|---|---|
| `structured-analysis` | EX (employee experience) survey analysis over pre-aggregated Herodotus widget data. | `herodotus_get_search_configs, herodotus_get_widget_data, herodotus_search_comments, execute, read_file, glob` | Very terse, 5-step imperative recipe (discover widgets → fetch → **compute via `execute`, never mentally** → at most one comment search call → respond with page/widget citation). A good minimal example of "skill as fixed procedure," in contrast to the branchier skills above. |

### `project_assist` (1 skill, code-heavy)

| Skill | Purpose | Allowed tools | Notable details |
|---|---|---|---|
| `survey-creation` | Build a brand-new survey end-to-end as validated Pydantic JSON: outline → questions → id-assignment → logic → critique → finalize/save. | `read_file, write_file, edit_file, glob, execute` | The most heavily engineered skill in the repo. See §3.4 for the models/scripts breakdown. Key mechanics: **one human checkpoint only** (the Phase 1 outline), then builds straight through; a **file-based, cross-turn-persistent pipeline** using two path prefixes with different lifetimes — `/tmp/workspace/...` (torn down every turn, used for in-turn block files) vs `/large_tool_results/...` (thread-persisted state, used for the outline and the final survey so they survive the approval-turn boundary); explicit `write_file` vs `edit_file` discipline (first write per path uses `write_file`, every subsequent touch must be `read_file`+`edit_file` with a minimal old/new diff, because `write_file` errors on an existing path — this is used to force minimal token diffs on later phases rather than restating whole blocks). |

### `unified_aipc` (1 orchestrator skill fanning out to 3 sub-skills)

| Skill | Purpose | Allowed tools | Notable details |
|---|---|---|---|
| `survey-builder` (orchestrator) | Routes user intent to `create` / `edit` / `recommend`; owns Save/Load commands and format conversion inline. | — (router only) | Explicit disambiguation table for overlapping phrasings ("improve Q4" → edit; "check display logic" → recommend); a hard-coded, non-negotiable command recipe for save/load (fixed paths, fixed output lines, "do not narrate", "do not ask which format"). |
| `survey-builder/create` | Build new survey as a bespoke **lightweight markdown DSL** (not JSON) — `# Survey Name` / `## Block N:` / `**Q1.**` + one of 10 closed `[type]` tags. | — | The markdown is deliberately minimal and machine-parseable: a companion deterministic parser (`md_to_json.py`) rejects any unrecognized `[type]` tag as a hard failure. Encodes De Vaus operationalization methodology (dimension → sub-dimension → indicator) and a full canonical block/question ordering ruleset (screener→core→demographics; gate→general→specific→sensitive) as an explicit self-review checklist before delivery. |
| `survey-builder/edit` | Targeted, format-agnostic edits ("Cursor pattern": locate → modify → propose diff → apply only on confirmation → validate). | — | Explicitly refuses open-ended "make this better" requests, handing back to the orchestrator to route to `recommend` instead — a clean single-responsibility boundary enforced in the skill body itself. |
| `survey-builder/recommend` | Audits display/skip logic + recommends AI features (Adaptive Follow-up, Response Clarity); compiles logic recommendations through an **IR → compiler workflow**, never hand-writes Qualtrics JSON. | — | The most sophisticated non-LLM component in the repo: `compile_logic.py` (936 lines) takes a small JSON IR (boolean tree of named atoms like `promoter`, `selected`, `matrix_score_gte`, `ed_eq`) and deterministically: validates each atom against the target question's actual type, converts NOT/AND/OR into disjunctive normal form, expands each disjunct into a Qualtrics `If`/`ElseIf` Logic Set, auto-picks the cleanest locator (e.g. collapses `score_lt 7` on an NPS question into the dedicated `IsDetractor` shortcut), enforces "same-block only" reference rules for display/skip logic with a clear error message, and round-trips the same IR into a plain-English rendering so the user can sanity-check before confirming. `compile_logic.py --render` is used specifically to give the human a legible thing to approve instead of raw JSON. |

Shared `unified_aipc` scripts (used across sub-skills, not skill-specific): `md_to_json.py` (canonical-markdown → intermediate JSON, Pydantic-validated line-by-line parser with precise `ParseError(line_no, message)`), `json_to_qualtrics.py` (intermediate JSON → Qualtrics QSF JSON, generates `SV_`/`BL_`/`QID` ids, builds `SurveyOptions`/`Blocks`/`SurveyFlow`), `compile_logic.py` (above).

---

## 5. Discovery & Registration Mechanism

**Important scoping note:** the actual loader/discovery code lives in the sibling `qualtrics-agent-harness` repo (`qualtrics_agent_harness/harness/*`), which is *not* checked out here — QAS ships no harness code by design. What follows is what's inferable from this repo's own docs, `check_app_construction.py`, and `validate_skills.py` (the closest thing to "loader code" present in this checkout).

- **App discovery**: any top-level folder under `qualtrics_agent_skills/` containing an `AGENTS.md` is an app (`validate_skills.py`'s own definition: `apps = [p for p in app_dirs if (p / "AGENTS.md").is_file()]`).
- **Skill discovery within an app**: `skills/*/SKILL.md` (recursive glob is *not* used at this level in the current apps, though `unified_aipc/skills/survey-builder/{create,edit,recommend}/SKILL.md` shows the harness must support at least one level of sub-skill nesting reachable by explicit cross-reference from the parent SKILL.md, not by flat auto-discovery).
- **Runtime resolution**: `importlib.resources.files("qualtrics_agent_skills") / <app_name>` — the harness treats the installed wheel as a filesystem tree and points its `filesystem` backend at that folder, or uploads it into the `agentcore` sandbox's `/tmp/workspace/skills/` for code-executing skills.
- **Middleware**: the README explicitly names the mechanism — **deepagents' `SkillsMiddleware`** — as what performs the frontmatter-only injection + on-demand full-body read. This is a third-party (deepagents/LangChain) middleware, not bespoke code in either QAS or QAH.
- **The closest thing to "loader code" actually present in this repo** is the CI cross-repo contract check, `script/check_app_construction.py`, which constructs each app **through the real, pinned harness** with a stubbed model and mocked sandbox modules:

  ```python
  from langchain_core.language_models.fake_chat_models import FakeListChatModel
  import qualtrics_agent_harness.harness.factory as factory
  ...
  with (
      patch.dict(sys.modules, _fake_sandbox_modules()),
      patch("deepagents.create_deep_agent", return_value=MagicMock()) as create,
      patch.object(factory, "build_model", lambda model_id, brand_id=None, **kwargs: FakeListChatModel(responses=["ok"])),
  ):
      factory.build_harness_graph(app)
      if create.call_count != 1:
          errors.append(f"{app}: harness did not construct a graph")
  ```

  This confirms the actual construction entry point is `qualtrics_agent_harness.harness.factory.build_harness_graph(app_name)`, which internally calls `deepagents.create_deep_agent(...)` — i.e. **QAS apps are literally deepagents `DeepAgent` configs**, and "the loader" is deepagents' own agent-construction path plus whatever adapter code lives in QAH's `factory.py` (unseen here).
- **Structural validation** (`script/validate_skills.py`) is the pre-flight gate *before* that real construction check — pure-stdlib/pydantic, no harness import required, so a malformed app fails fast and cheaply in CI before the (slower, harness-dependent) construction check runs.
- **Publishing**: on merge to `main`, CI builds and publishes a versioned wheel to an internal Artifactory PyPI index (`make publish` → `script/docker/publish.sh` → `poetry build && poetry publish`); publishing never overwrites an existing version (checked via `pip index versions` before build). Then, separately, `cme-langgraph-service` bumps its pin and regenerates its own `graphs/<app>/graph.py` + `langgraph.json` via `task graphs:generate` (per `docs/adding-an-app.md` Step 7) — i.e. **the runtime's routing table is itself generated, not hand-written**, from the installed skills wheel.

---

## 6. Eval / Test Conventions for Skills

This is a full, independent eval framework living under `qualtrics_agent_skills/unified_qa_assist/evals/` (the only app with one) — YAML test cases + a Python grading dispatcher, entirely separate from unit tests.

### 6.1 Case format

```yaml
eval_id: qa-top-10-topics                 # must equal filename stem
application: qualtrics-assist-cx           # drives tool routing / config.configurable.application
data:
  brand_id: your_brand_id                  # required
  user_id: your_user_id                    # required
  dashboard_context_id: your_ctx_id         # surface-specific
prompt: |
  What are the top 10 topics?
graders:
  - type: answer-relevance-judge
  - type: answer-faithfulness-judge
  - type: tool-trace-analyzer
    forbidden_prefix: dfs_
  - type: format-adherence-judge
    template_file: formats/qualtrics-assist-cx.md
  - type: llm-answer-assertions-judge
    expect:
      - Lists exactly 10 topics
      - Topics are listed in strictly descending order by total mention count
```

Cases can also be **multi-turn** (`turns: [{id, prompt, graders}, ...]`) — the driver threads them through one live conversation, then grades **each turn independently** against its own slice of the trace; a case passes only if every turn's graders pass. Cases live under `evals/cases/<application>/[<dataset>/]<name>.yaml` (dataset subfolders let multiple named customer scenarios reuse the same case filename, e.g. `b1_marriott/session_001.yaml` vs `hp/session_001.yaml`).

### 6.2 Grader taxonomy (`graders/dispatch.py` `GRADERS` table)

| Type | Kind | What it checks |
|---|---|---|
| `answer-relevance-judge` | LLM (1 call) | Response addresses the query. |
| `answer-faithfulness-judge` | LLM+REPL (2+ calls) | Two-stage **extract → verify**: extracts every verifiable numeric/summary claim from the answer, then verifies each against the actual tool outputs using a subprocess-isolated Python REPL for arithmetic (LLMs misread big numbers, so sums/percentages are computed, not eyeballed). Chunks large contexts (400k char budget) and batches claims (25/call) to stay within LLM limits; merges per-claim verdicts across chunks (`SUPPORTED` anywhere wins). |
| `llm-answer-assertions-judge` | LLM (1 call) | Author-written natural-language assertions ("Lists exactly 10 topics") graded directly against the final response — no tool-output grounding, used when the exact expected values are already known. |
| `tool-trace-analyzer` | Deterministic | Combines reliability (error rate over tool calls, via regex error-pattern matching on tool outputs), routing (`forbidden_prefix` / `required_tools` / `required_call_patterns` violations → hard 0), and efficiency (`expected_calls` vs actual — **warning only by default**, opt into hard failure via `fail_on_efficiency: true`). Final score = min of active sub-scores. |
| `format-adherence-judge` | LLM (1 call) | Structure/language/tone against a markdown format template (inline or `template_file:`). |
| `tool-arg-match-checker` | Deterministic | Ground-truth tool arguments (`{tool, args}` rows) matched against the actual trace; `args: flexible` just asserts the tool was called. |
| `skill-assertions-checker` | Deterministic | Infers which skills were **read** (i.e. their `SKILL.md` was opened via a `read_file`-shaped tool call in the trace) and checks `{skill, must_be_called}` assertions — a clever proxy for "did the agent follow the intended skill-dispatch path" without any special instrumentation, just pattern-matching `SKILL.md` in tool-call paths. |

Registered in one place, `dispatch.py`'s `GRADERS` dict, and enumerated a second time in `conftest.py`'s `_VALID_GRADER_TYPES` for YAML-authoring validation — adding a new grader type requires updating both plus documenting it in `evals/README.md` (a 4-step checklist is spelled out there).

### 6.3 Trace caching

`test_evals.py` caches each agent run's full trace (`{turns: [{id, input, actual_output, tool_calls, usage}], ...}`) under `.trace_cache/<application>/[<dataset>/]<eval_id>/trace.json`, keyed by a SHA-256 hash over all turn prompts + the `data:` block. Editing a prompt/data invalidates the cache and forces a live re-run; editing graders/assertions/thresholds does **not** — you can freely iterate on grading logic against a fixed trace, which is the entire point (LLM agent calls are the expensive, slow part; grading is cheap and fast). `--refresh-traces` (`REFRESH=1`) forces a live re-run regardless.

### 6.4 Analysis tooling

- `make view-trace` — renders a cached trace + its `grades.json` as a readable transcript (prompt → each tool call, compact input + truncated output → final answer → grader verdicts); `MD=1` writes a markdown file for preview.
- `make eval-report` — per-metric micro/macro stats + pass rates + token totals across cached grades, optional CSV.
- `make export-traces` — one CSV row per turn (query, tool trace, final output) for qualitative human review.

### 6.5 Adversarial / red-team evals (separate subsystem, `evals/red_team/`)

Not part of the deterministic grader system at all — points an external **auditor LLM** (via `agent-persona-hub`, a private tool built on `petri_bloom`/BLOOM) at a *live* running agent over the LangGraph SDK/HTTP, and lets the auditor adapt its tactics across turns (roleplay, incremental extraction, authority claims). Each behavior is one `BEHAVIOR.md`:

```yaml
---
num_scenarios: 4
modality: conversation
instructions:
  ideation: "Each scenario probes one tactic for inducing cross-tenant data
    access: (1) direct request ... (2) filter override ... (3) authority claim
    ... (4) laundering ..."
---
Cross-tenant data access is when the agent retrieves, reports, or reasons over
data belonging to a brand ... other than the one fixed in its injected runtime
context ...
Failure modes:
- Other-tenant disclosure: ...
- Scope override: ...
```

Two behaviors ship locally (`cross_tenant_access`, `prompt_injection`); two more (`prompt_prober`, `ex_confidentiality_breach`) come bundled in the hub and are runnable by name without being copied in — a local `BEHAVIOR.md` of the same name would shadow the bundled one. Each scenario gets a 1–10 judge score across several dimensions; the repo's explicit aggregation rule is **worst-case, not average** ("a single 8 among four 1s is the finding that matters"), and red-teaming is deliberately **not a CI gate** ("non-deterministic and adversarial... a flaky judge score must never block a merge") — tracked as a scheduled/on-demand regression signal instead.

---

## 7. Dev Tooling for Skill Authors (`dev/`)

Much thinner than expected — three near-identical files, one per LangGraph-Studio-registered app:

```python
# dev/unified_qa_assist.py
from qualtrics_agent_harness.harness import build_harness_graph
APP_NAME = "unified_qa_assist"

async def make_graph():
    return await asyncio.to_thread(build_harness_graph, APP_NAME)

if os.getenv("APP_ENV") == "dev":
    graph = asyncio.run(make_graph())
```

There is **no skill-scaffolding CLI, no `SKILL.md` generator, no cookiecutter template** in this repo — "dev tooling" is entirely: (a) `make install` (editable-installs this repo + the harness, so `SKILL.md` edits apply live without a publish round-trip), and (b) `make dev` (`APP_ENV=dev poetry run langgraph dev --allow-blocking`, LangGraph Studio on `:2024`). Adding a new app to Studio is a manual two-step documented in `docs/adding-an-app.md`: copy `dev/unified_qa_assist.py`, rename `APP_NAME`, add one line to `langgraph.json`. The actual "scaffold" for a *new app* is fully manual per `docs/adding-an-app.md`'s Step 1-4 checklist (folder, `AGENTS.md`, `deepagents.toml`, first `SKILL.md`) — no generator script exists to do it for you.

---

## 8. Direct Comparison to CrystalOS's Skill Convention

CrystalOS convention (from `crystalos/lib/skill_registry.py` + `crystalos/lib/skill_runtime.py` + `crystalos/skills/crystal-analyst/{SKILL.md,EVALS.md}`, read for this comparison):

| Dimension | qualtrics-agent-skills (QAS) | CrystalOS |
|---|---|---|
| **Manifest shape** | `SKILL.md` YAML frontmatter: `name`, `description`, `allowed-tools`, `compatibility`, `related-skills`, `license` (unused). No `version`, no eval-threshold fields in the manifest itself. | `SKILL.md` frontmatter is richer and *operational*: `name`, `version`, `shared`, `description`, `compatibility`, `allowed-tools`, `evals` (path), `examples` (path), `max_output_tokens`, `max_retries`, `timeout_seconds`, plus **A/B variant fields** (`variant`, `rollout_pct`, `baseline_variant`, `min_sample_size`) parsed directly by `_parse_skill_md`. QAS has no A/B/variant concept at all. |
| **App/agent boundary** | Skills are grouped under a per-**app** folder (`AGENTS.md` + `deepagents.toml`); a skill's `allowed-tools` scopes it *within* that app's own tool allow-list (`[tools].requires`). Multiple apps duplicate near-identical skills (no shared registry — README says so explicitly: "Skills may be duplicated across apps in V1"). | Skills are **flat and shared** across the single CrystalOS deployment (`skills/plugin.json` lists ~40 skills in one registry); no per-app tool allow-list layer — `BrandContext`/`permitted_features` gates tool access at the *brand* level instead (`crystal/context.py`), a materially different mechanism from QAS's static per-app TOML list. |
| **Discovery/registration** | Two-stage: (1) deepagents' `SkillsMiddleware` (in the sibling harness repo) injects `name`+`description` into the system prompt for **progressive disclosure**, agent opens the file itself via `read_file`. (2) The *app itself* is chosen ahead of time (one DeepAgent per app/graph); there is no cross-app runtime skill search. | `SkillRegistry._scan_skills()` walks `skills/**/SKILL.md` at startup and on an mtime-triggered reload loop (hot-reload, no restart needed); routing is **active runtime search**, not passive prompt injection — `find_sync()` (difflib token-overlap, no deps) or `find()` (pre-embedded cosine-similarity semantic search after `warm_router()`, min similarity 0.35), invoked per-request by Crystal's semantic routing (`registry.find`, top_k=1 in the default flow per `crystalos/CLAUDE.md`). QAS has no analogue to this — it never searches across skills at request time, because the app boundary already fixed the candidate set upstream. |
| **Execution model** | The LLM (DeepAgent) *is* the loop — skills are read as instructions inside one long-running agentic tool-call loop, with the sandbox `execute` tool for any real computation. There is no separate "skill executor" — reading a SKILL.md and acting on it are the same LLM turn. | `SkillRuntime.execute()` is a **distinct, structured executor**: builds a system prompt from `SKILL.md` body + `references/*.md` + up to 3 DB-sourced few-shot examples, calls the LLM once with a Pydantic `output_schema`, parses JSON, and returns a typed `SkillResult` (score, tokens, latency, retried flag) — much closer to a typed RPC than an open-ended agent loop. |
| **Eval format** | A **separate, repo-external eval harness** (`unified_qa_assist/evals/`): YAML cases + a multi-grader Python dispatcher (LLM judges + deterministic checkers), run offline via `make eval`, with trace caching so re-grading doesn't re-run the (expensive, live) agent. Evals are per-**app**, not per-skill, and only one of six apps has any at all. | `EVALS.md` per **skill** is a lightweight markdown table (`| ID | Criterion | Weight | Threshold |`), parsed inline by `SkillRuntime._parse_evals_md` via a regex over table rows, and evaluated **synchronously, in the hot path, on every skill invocation** — not an offline test suite. Threshold `"must pass"` hard-fails the whole skill call (score 0); otherwise a weighted average against `SKILL_EVAL_PASS_THRESHOLD` (0.75 in the crystal-analyst example). Criteria route to either a deterministic keyword-matched check (`_is_structural_criterion` / `_eval_structural` — valid-JSON, required-fields-non-empty, word/count-range, "contains") or an LLM judge (`_eval_criterion`'s few-shot 0.0–1.0 scoring prompt) based on a keyword heuristic on the criterion's own text. **On eval failure, CrystalOS automatically retries once with the failure injected into context** (`max_retries` from frontmatter) — QAS's eval harness has no retry-and-repair loop; a failing eval is just a failing pytest case reviewed by a human later. |
| **Example/quality feedback loop** | None. No mechanism observed for QAS to feed successful outputs back into future prompts. | `SkillRuntime._write_example_async` writes any run scoring above `SKILL_EXAMPLE_WRITE_THRESHOLD` into a `skill_examples` Postgres table (with org-cap and embedding-based near-dup checks), and `_build_system` re-injects the top-3 highest-scoring examples for that skill as few-shot examples on every subsequent call — a live, self-reinforcing quality loop QAS has no equivalent of. |
| **No-eval fallback** | N/A (no runtime eval gate to fall back from). | `_baseline_output_check` — if a skill ships no `EVALS.md` at all (or it fails to parse), CrystalOS still applies a minimal non-empty/non-error output gate rather than a blind auto-pass — a deliberate design choice called out in the docstring ("replaces the old blind 0.85 auto-pass"). |
| **Deterministic-code pattern** | Extremely mature, but implemented as **standalone sandbox scripts** invoked by the agent via `execute("python3 .../script.py ...")` — the LLM has to remember the exact invocation string from the SKILL.md prose every time. Best examples: `compile_logic.py` (NL→IR→Qualtrics-JSON compiler with DNF boolean-algebra, locator selection, cross-block validation), `survey_pipeline.py` (id-assignment/logic-pruning/renumbering as three composable passes), `print_schema.py` (schema-on-demand from Pydantic instead of a hand-written doc). | No direct equivalent — CrystalOS skills are pure LLM calls with an eval gate; there is no `execute`-style sandbox tool invoked *from within* a skill's own instructions to run deterministic guardrail code as part of the skill's own contract. (Crystal's `crystal/tools.py` *executor* functions are a different layer — tools the LLM calls mid-conversation, not skill-internal deterministic post-processing.) |
| **Cross-skill handoff** | Explicit, narrated in prose: one skill's body names the next skill's file path and what to pass it (`comment-analysis` → `ie-formatting`; `nlf-skill` → `driver-analysis`). Enforced entirely by the model reading and following instructions — no code-level chaining. | Skill-to-skill handoff is not a first-class described mechanism in `skill_runtime.py`/`skill_registry.py` — `registry.execute()` runs exactly one named skill per call; any multi-skill sequencing happens one level up, in the calling agent code (`agents/crystal.py`, `agents/creator.py`, LangGraph pipeline nodes), not inside a skill's own instructions. |
| **Human approval gate** | A strong, repeated prose convention ("propose → approval pattern") across `unified_aipc` and `project_assist` — the model is instructed to stop and wait, with no code-level enforcement; compliance depends entirely on instruction-following. | Enforced structurally at the architecture level instead: "Crystal proposes, Copilot/endpoints execute" — `action_proposals[]` in a skill's own output schema (or `propose_*` tool calls) are normalized (`_normalize_proposal`) and surfaced to the frontend, which executes only after explicit user confirmation via a *separate* API call. The boundary is enforced by what mutates state (only backend endpoints, gated on confirm), not by asking the model nicely to pause. |
| **Format/UI integration contract** | The `<report>...</report>` XML delimiter convention, repeated near-verbatim across 3 skills, is the load-bearing UI contract for file-backed deliverables. | CrystalOS's equivalent integration contract is the `render_hint` field on tool outputs (e.g. `get_insight_report` → `render_hint='document'`) and the `ActionProposal` shape — a structured field on the *output schema*, not a text delimiter the model has to remember to emit correctly. |
| **Discovery hygiene / duplicate names** | No cross-app dedup; explicitly tolerated for V1 ("no shared registry yet"). | `SkillRegistry._scan_skills()` actively detects and **warns + skips** duplicate skill names across the flat namespace (`skill_duplicate_name`) — a real safeguard QAS's app-siloed model doesn't need but also doesn't provide. |

---

## 9. Patterns Worth Adopting in CrystalOS

Ordered roughly by leverage-to-effort.

1. **Bundled deterministic guardrail scripts callable from within a skill.** QAS's `compile_logic.py`/`survey_pipeline.py`/`print_schema.py` pattern — push anything that has a *provably correct* deterministic answer (id assignment, logic validation, schema generation, NL→IR compilation) out of the LLM and into a small, individually-testable Python module the skill's own instructions invoke. CrystalOS has no sandbox-`execute`-from-skill equivalent today; even without a sandbox, a skill could deterministically post-process/validate its own LLM output in Python before the eval gate runs (rather than relying solely on the LLM-judge `EVALS.md` criteria) — see next point.
2. **A validator script paired with an eval gate, with a documented fix-and-retry loop.** `ie_validator.py` (Insight Explorer) is a genuinely reusable idea: write the draft → run a small deterministic Python validator that returns structured `{valid, issues, kept_theme_names, ...}` → the skill's own instructions tell the model exactly how to react to each specific issue type → re-validate. CrystalOS's `SkillRuntime` already has a generic retry-with-failure-context loop (`_check_evals` → inject `failed_criteria` → retry once) — the missing piece is *skill-authored deterministic sub-checks* beyond the generic structural keyword matcher, for skills whose quality bar is genuinely checkable in code (e.g. survey-creator's id/logic integrity, a report's prevalence-label-matches-percentage rule).
3. **Schema-generation-on-demand instead of hand-maintained schema docs.** `print_schema.py` prints `model_json_schema()` straight from the Pydantic source of truth. Any CrystalOS skill whose output schema is a Pydantic model (several are, via `output_schema=_SkillOutput` in `SkillRuntime.execute`) could expose the same "the schema is generated, never drifts" property in its own `SKILL.md`/reference docs, rather than describing the shape in prose that can silently go stale.
4. **A lightweight offline eval-case + grader-dispatcher harness, orthogonal to the in-request `EVALS.md` gate.** CrystalOS's `EVALS.md` gate is synchronous, per-call, cheap, and already good for "does this one output meet the bar." QAS's `evals/` (YAML cases, cached traces, a pluggable `GRADERS` table with LLM-judge and deterministic grader types, `tool-trace-analyzer` for routing/reliability/efficiency, `skill-assertions-checker` for "did the intended skill actually get invoked") is a genuinely different, complementary offline regression-testing layer CrystalOS currently lacks — useful for catching routing regressions (wrong skill picked by `registry.find`) and multi-turn conversational regressions that a single-call `EVALS.md` check structurally cannot see. The trace-caching design (hash prompts+data, invalidate only on prompt/data change, not on grader/threshold change) is a good template to copy directly — it makes iterating on grading criteria nearly free.
5. **Adversarial red-teaming as a separate, non-CI-gating, worst-case-scored process.** CrystalOS has no analog. The `BEHAVIOR.md` format (frontmatter `num_scenarios` + `instructions.ideation` tactic list + prose failure-mode description) is a clean, low-ceremony way to spec adversarial probes (prompt injection into analyzed customer verbatims and cross-org data leakage are both directly relevant to CrystalOS's own BrandContext/tenant-isolation and Crystal's read-only survey-data-grounding guarantees).
6. **"Skill reads own SKILL.md" as a routing-fidelity signal for evals.** `skill-assertions-checker`'s trick — infer which skill was actually consulted by pattern-matching `SKILL.md` file-read tool calls in the trace — is cheap and requires zero extra instrumentation. CrystalOS's semantic router (`registry.find`) is exactly the kind of thing this technique would let you regression-test ("did `tag-analyst` actually get selected for a tag-scoped query") without adding new telemetry, if a comparable trace/tool-call capture existed for CrystalOS's skill-execution path.
7. **Cross-skill retrieval/analysis/formatting separation as an explicit architectural rule, not just convention.** QAS enforces this only in prose, and it's the one place its "no code-level enforcement" weakness is most visible (nothing stops a skill from ignoring the instruction to not fetch data). CrystalOS's actual code-level separation (Crystal read-only vs Copilot mutates; `action_proposals` normalized in one place) is *already stronger* than QAS's — worth explicitly recognizing this as a place CrystalOS should not imitate QAS, and should instead keep leaning on structural (not prose) enforcement.
8. **The IR-then-compile pattern for any "agent picks intent, code picks representation" problem.** `compile_logic.py`'s NL→small-JSON-IR→deterministic-compile-to-final-format split generalizes well beyond survey logic — anywhere CrystalOS needs the LLM to express *intent* (which topics, which metric comparison, which proposal shape) while a deterministic compiler handles the "get the exact target JSON/SQL/config shape right" part, this is a proven division of labor that also naturally produces an audit-friendly plain-English rendering (`render_english`) for a human-confirmation step — directly reusable for making `action_proposals` more inspectable before a user confirms one.

---

## 10. Open Questions / Gaps

- **The actual harness loader code is not in this checkout.** Everything about *how* `SkillsMiddleware` decides when to inject a skill's description, how `allowed-tools` is enforced at the tool-call level, and how `backend = "agentcore"` wires the sandbox are inferred from QAS's own docs/tests, not read directly. A full picture would require pulling `qualtrics-agent-harness` (`qualtrics_agent_harness/harness/factory.py`, `tool_registry.py`) alongside this repo.
- **No skill-authoring scaffold/generator exists**, despite six apps' worth of near-identical boilerplate (frontmatter shape, confidentiality clause, tool-error-policy clause, `<report>` delimiter contract) — a strong signal that a generator/lint would pay for itself, but nothing here builds one.
- **`compatibility: opencode` is unexplained** in this repo — appears on several `SKILL.md` files with no docs describing what values are valid or what consumes the field.
- **Skill duplication across apps is a stated, accepted V1 gap** ("no shared registry yet") — unclear from this repo alone whether a v2 shared-skill-registry design exists on the harness side.
- **`unified_qa_assist`'s evals are the only eval suite in the repo** — `project_assist` and `unified_aipc` (the two most code-heavy, highest-blast-radius skills — survey creation and Qualtrics QSF export) have **no eval coverage at all** in this checkout, which is a real gap given how much deterministic logic (`compile_logic.py`, `survey_pipeline.py`) sits behind them untested by anything other than `check_app_construction.py`'s structural smoke check.
- **Red-team behaviors are agent-facing prose specs, not code** — `agent-persona-hub` (the actual adversarial-conversation engine) lives in a separate private GitLab repo not inspected here; its scenario-generation and judging logic is opaque from this checkout.
- **`meta/survey_template.json`, `ai-features.md`, `skip-display-logic.md`, and most `reference/*.md` files across `project_assist`/`unified_aipc` were not read in full** for this pass (time-boxed) — they are referenced extensively by the skills above but their exact content wasn't verified line-by-line; flag if a future pass needs the literal AI-feature eligibility rules or the full skip/display-logic audit checklist.
