# Findings: Marcus — CrystalOS Architecture Expert

**Role recap:** deep-codebase lens. My job is to be the authoritative map of every existing
CrystalOS capability that must be preserved (per BRIEF.md's "what must keep working" list,
verified against actual source — not the CLAUDE.md prose, which can drift), exactly where a
harness-style refactor would touch each one, and the landmines/regression risks specific to
CrystalOS's current implementation.

**Method:** I read `crystalos/CLAUDE.md`, `agents/crystal.py` (2,212 lines), `lib/skill_runtime.py`,
`lib/skill_registry.py`, `lib/turn_publisher.py`, `crystal/context.py`, `crystal/registry.py`
(1,027 lines), `crystal/tools.py` (3,813 lines), `main.py` (1,994 lines), `graphs/insights.py`
(5,781 lines), `graphs/custom_analysis.py` (608 lines), `lib/skill_survey_adapter.py`, and five
skill folders (`crystal-analyst`, `copilot-analyst`, `compliance-scanner`, `tag-analyst`,
`workflow-analyst`) in full — every fact below is traced to a specific file/line/function, not
paraphrased from CLAUDE.md. Where CLAUDE.md's prose and the code disagreed, I flag it explicitly
(see §1.0).

---

## 1. Vantage-point summary — the authoritative, code-verified functionality checklist

### 1.0 Where CLAUDE.md already drifted from source (found during this pass)

- **Node count**: CLAUDE.md says the Insight Pipeline is "17 nodes." The actual graph
  (`graphs/insights.py:5598-5615`, `build_insight_graph()`) registers **18** nodes — `ai_triggers`
  (post-publish signal detection) exists in code but isn't counted in the doc. Any teammate quoting
  "17 nodes" should re-derive, per CLAUDE.md's own stated policy ("re-derive, don't trust prose").
- **Tool count**: CLAUDE.md says `TOOL_REGISTRY` has 58 entries. I did not recount by hand (the doc
  itself says to re-derive via `count '"name":' in TOOL_REGISTRY` — flagging as unverified rather
  than asserting a number).
- Everything else I checked (skill-first fallback chain, action-proposal boundary, BrandContext
  permission model, checkpoint dual-write gating, credit-preflight ownership, custom-analysis hard
  invariants) matched the code exactly, including the specific constant names and thresholds. CLAUDE.md
  is otherwise a reliable, current document — the two items above are the only drift I found.

### 1.1 Skill-first Crystal streaming + fallback chain

Verified in `agents/crystal.py`:

- `_run_skill_stream` (line 1955) is the default entry (`main.py:1718` `crystal_stream_endpoint`,
  unless `?legacy=true`). Flow: rate check (`_crystal_rate_count`, ≤10/org/min) → mint `turn_id`
  (before any SSE frame ships — the "G1 fix" contract, so the client-visible `turn_id` and the
  `crystal_turn_events` primary key are the same value) → resolve best skill (`_resolve_forced_skill`
  hard-force checks first, then `registry.find(top_k=1)`, then `find_sync` difflib fallback) → fetch
  ≤3 tools directly by priority list (no LLM tool-selection) → `_skill_synthesis` via `SkillRuntime` →
  on `None`, fallback to single-shot `_run_crystal`.
- **Fallback chain is real and multi-layered**: `_skill_synthesis` returns `None` on missing
  skill / eval fail / normalize fail (line 1489, broad `except Exception`) → `_run_crystal` single
  call. If the *generator itself* throws before yielding anything, `main.py`'s
  `crystal_stream_endpoint.event_stream()` (line 1793) catches it and calls `_run_crystal` **again**
  as an outermost double-fallback, minting a fresh `turn_id` and best-effort firing telemetry — this
  third layer is not documented in CLAUDE.md's one-line summary but is real code (`main.py:1801-1819`).
- **Legacy ReAct loop**: `_run_react_loop_streaming` (line 1496), gated behind `?legacy=true` AND
  `user_role in ("admin", "brand_admin")` (`main.py:1749`, whitelist-validated — `raw_role` is checked
  against a `VALID_ROLES` set before being trusted, since "user_role should ultimately come from
  backend JWT injection" per the code comment). Runs the full LLM-driven `_react_plan_tools` tool
  loop, then still tries skill-first synthesis before falling back to `_run_crystal`.
- **Two independent debug channels**: `?debug=true` (also role-gated) emits `debug_routing` /
  `debug_timing` SSE events; `store_trace=True` persists a full trace row to `crystal_debug_traces`.

### 1.2 SkillRuntime EVALS.md hybrid gate + retry + example bank

Verified in `lib/skill_runtime.py`:

- `SkillRuntime.execute()` (line 88): resolve model config → build system prompt (SKILL.md body +
  `references/*.md` + top-3 few-shot examples from `skill_examples` DB table) → first LLM call
  (`asyncio.wait_for` with the skill's `timeout_seconds`) → `_check_evals` → **retry once** on failure
  with injected `retry_context` (`failed_criteria`, `eval_score`, `previous_output`) → re-check evals.
- **EVALS.md parsing** (`_parse_evals_md`, line 428): markdown table rows matching `E\d+` become
  `{id, description, weight, threshold}`. `threshold == "must pass"` rows are hard gates (any failure
  ⇒ `eval_passed=False, score=0.0` regardless of other criteria); weighted rows contribute to a
  weighted average, must clear `SKILL_EVAL_PASS_THRESHOLD` (0.75, `constants.py:371`) with zero
  soft-failing criteria.
- **Structural vs. LLM-judge split** (`_is_structural_criterion`, `STRUCTURAL_KEYWORDS` frozenset):
  keyword-matched criteria ("valid json," "required fields," "word count," "contains," "non-empty" —
  note "present" alone is deliberately excluded per an inline comment, because conditional-presence
  criteria like crystal-support's "present when resolved=false" are semantic, not structural) are
  scored deterministically in `_eval_structural`; everything else goes to a real LLM call
  (`_eval_criterion`, temp=0, max_tokens=5, parses a bare float).
- **Baseline gate for no-EVALS.md skills** (`_baseline_output_check`, line 332): NOT a blind
  auto-pass — requires a non-empty dict, rejects pure `{"error": ...}` payloads, requires at least one
  field with a string ≥20 chars or a non-empty list/dict, scores 0.70 if so. This replaced a prior
  "blind 0.85 auto-pass" (explicit in the docstring) — worth knowing since a harness "fail-fast
  validation gate" migration could accidentally reintroduce a blind-pass regression here if not
  careful to preserve this specific baseline behavior.
- **Example-bank write-back** (`_write_example_async`, fire-and-forget `asyncio.create_task`): only
  when `eval_score >= SKILL_EXAMPLE_WRITE_THRESHOLD` (0.75); org cap at 20% of a skill's total example
  rows; near-duplicate check via pgvector cosine similarity against `embedding <=> ...`, silently
  skipped if pgvector/embedding unavailable; `prune_skill_examples()` SQL function caps total rows per
  skill. `_consolidate_example_bank` (module-level, separate call site not wired into the hot path per
  what I read — likely a scheduled job) removes near-duplicates at 0.85 cosine similarity.
- **Confirmed empirically (via the skill-folder read agent) that most EXAMPLES.md files are
  auto-generated empty placeholders** — the example bank exists as a mechanism but is not populated
  for 4 of 5 skills sampled (`crystal-analyst`, `copilot-analyst`, `compliance-scanner`,
  `tag-analyst`). Only `workflow-analyst` has a hand-authored, populated EXAMPLES.md (6 worked
  examples). This is functionality that exists in code but is largely dormant in practice — worth the
  team knowing before assuming "the example bank is doing real work everywhere."

### 1.3 Action-proposal boundary

Verified in `agents/crystal.py` + `crystal/registry.py`:

- `ActionProposal` model (line 159): `id`, `type`, `title`, `description`, `cta_label`, `params`,
  `priority`, `estimated_time`, `business_rationale`, `requires_confirmation: bool = True` (always
  True — stated as "safety guarantee" in the field comment).
- **Two emitters, one normalizer.** Skill path: skill output's optional `action_proposals[]` /
  `actions[]` → `_normalize_skill_output` (line ~1280) → `_normalize_proposal`. Tool path: `propose_*`
  tool results (tools in `ACTION_TOOL_NAMES`, `crystal/registry.py:1009`) → `_extract_action_proposals`
  (line 1014) → same `_normalize_proposal`.
- `_normalize_proposal` (line 974): maps `_PROPOSAL_TYPE_ALIASES` (`workflow`→`create_workflow`,
  `alert`→`create_alert`, `case`→`create_case`, `manual_insight_run`→`trigger_manual_insight_run`,
  etc.), fills a **turn-scoped slug id** when absent — `f"{turn_id}:{slug}"` — with a documented
  dual-requirement (unique per emission across turns, but stable across the same proposal's own
  emitted→accepted→succeeded/failed POST lifecycle, per the docstring referencing migration
  `20260806000001` and a specific dedup bug it fixed). This is subtle, load-bearing logic that a
  harness "provenance stamping" pattern must not silently break by re-minting ids differently.
- `TOOL_REGISTRY` (`crystal/registry.py:13-960`) is a flat list of dicts (name/description/scope/
  input_schema) — no code-level JSON-Schema validation of tool call args happens against this schema
  anywhere I found; it's descriptive (used to build the ReAct prompt's tool list) not enforced.
  `get_tools_for_scope`, `DATA_TOOL_NAMES`/`ANALYSIS_TOOL_NAMES`/`ACTION_TOOL_NAMES` partition tools for
  prompt-section grouping and `is_action_tool()`/`is_analysis_tool()` checks.

### 1.4 BrandContext / ROLE_PERMISSIONS / tool-gating

Verified in `crystal/context.py` (69 lines, read in full):

- `BrandContext` (frozen dataclass): `brand_id`, `brand_name`, `brand_persona`, `data_region`,
  `plan_tier`, `permitted_features: frozenset`, `restricted_features: frozenset`,
  `custom_instructions`, `support_ticket_url`, `feature_request_url`, plus tunables
  (`max_tool_turns=10`, `thread_ttl_days=7`, `progressive_tiers=(10,40,100,250)`) — **these tunables
  are declared on the dataclass but I did not find any call site in `crystal.py` that reads
  `brand.max_tool_turns` or `brand.thread_ttl_days` instead of the hardcoded `CRYSTAL_MAX_TOOL_TURNS`/
  `CRYSTAL_THREAD_INACTIVITY_TTL_DAYS` constants** — worth flagging as either dead/aspirational fields
  or a wiring gap, not something I could resolve without checking every consumer.
  `ROLE_PERMISSIONS` (module dict): `viewer` ⊂ `editor` ⊂ `admin` ⊂ `brand_admin`, each a frozenset of
  scope strings (`data:read`, `data:export`, `data:pii`, `survey:write`, `workflow:write`,
  `admin:read`, `brand:admin`).
- `_resolve_permissions(brand, role)` (line 34): `brand_admin` role gets `role_perms | brand.
  permitted_features` minus `restricted_features`; all other roles get `role_perms ∩
  brand.permitted_features` (if non-empty) minus `restricted_features`. This is real intersection
  logic, not a stub.
- **Enforcement point**: `_build_filtered_tool_list` (`crystal.py:733`) filters the ReAct-loop tool
  list by `TOOL_PERMISSION_MAP` (`export_responses`→`data:export`, `view_respondent_pii`→`data:pii`,
  `configure_alerts`→`workflow:write`, `manage_survey`→`survey:write`) — **only 4 tools have a
  permission mapping out of ~60 in the registry; every other tool has no entry in
  `TOOL_PERMISSION_MAP` and is therefore always included regardless of role** (the function's own
  docstring says so explicitly: "Tools with no entry in TOOL_PERMISSION_MAP are always included").
  This enforcement point **only runs in the legacy ReAct agentic prompt path**
  (`_build_system_prompt_agentic`) — I did not find an equivalent permission filter applied to the
  skill-first path's `_fetch_skill_context`'s direct tool dispatch (`agents/crystal.py:1671`,
  `_fetch_skill_context`) or to `_react_plan_tools`'s actual `dispatch_tool` calls (only the *prompt
  listing* is filtered, not the dispatch call itself in `_react_plan_tools`). This is a genuine gap
  worth the team's attention independent of any harness rearchitecture — see §4.

### 1.5 Semantic skill router

Verified in `lib/skill_registry.py`:

- `SkillRegistry._scan_skills()` walks `skills_dir.rglob("SKILL.md")`, parses YAML frontmatter
  (`_parse_skill_md`), tracks per-skill mtimes for hot-reload (`_reload_loop`, interval differs
  dev/prod via `SKILL_REGISTRY_RELOAD_INTERVAL_DEV/PROD`), and a duplicate-name guard (logs a warning
  and skips — the second definition never registers, first-wins).
- `warm_router()` (called once at FastAPI lifespan startup, `main.py:158`) pre-embeds
  `"{name}: {description}. {use_cases}"` for every skill via `embed_texts`. `find(query, top_k=3)`:
  cosine similarity, **0.35 minimum threshold**, falls back to `find_sync()` (difflib token-overlap +
  a name-substring boost, **0.2 minimum threshold**) if the router isn't warmed or embedding fails.
  `find_with_scores` is the debug-routing variant that always returns scores whichever path fired.
- **A/B variant machinery exists in code** (`SkillVariant`, `resolve_variant` via consistent MD5-bucket
  hashing, `rollout_pct`, `baseline_variant`, `min_sample_size`) but **the skill-folder read agent
  grepped all `skills/*/SKILL.md` and `plugin.json` and found zero skills actually using
  `variant`/`rollout_pct` frontmatter** — this is dormant infrastructure, not active behavior. A
  harness rearchitecture shouldn't assume it needs to preserve live A/B traffic-splitting behavior,
  but the *code path* (`resolve_variant`) is real and callable, so don't delete it either without
  checking for external callers.
- **Two hard-force routing overrides exist entirely in `agents/crystal.py`, not in the registry**:
  Wave 15's `surface == "workflow_builder"` page-context force, and Wave 18's
  `_is_workflow_taxonomy_question()` regex-based message-content force (`_resolve_forced_skill`, line
  1933) — both bypass `registry.find()` entirely for `workflow-analyst`. Any harness "named routing
  hook point" design must account for these two hard bypasses as first-class, not edge cases — they
  are the only two skills-routing paths in the whole system that don't go through the semantic router
  at all.

### 1.6 turn_publisher telemetry + quality signals + capability-gap logging

Verified in `lib/turn_publisher.py` (187 lines, read in full):

- `TurnEvent` dataclass, written via fire-and-forget `asyncio.create_task` inside `publish_turn_event`
  (never raises — every DB write wrapped in try/except-log). `id` is **caller-minted** (the `turn_id`
  from `agents/crystal.py`) specifically to skip the column's `DEFAULT gen_random_uuid()`, per an
  explicit comment — so the client-visible id and this row's PK are identical (the "G1 fix" mentioned
  in multiple places in `crystal.py`).
- `detect_quality_signal(query)`: pure keyword match against `_FRUSTRATION`/`_SATISFACTION` lists
  (e.g. "that's wrong," "try again" vs. "perfect," "thank you") — no LLM call, deterministic, cheap.
  This is itself an example of "Tier-0 deterministic" logic the harness synthesis's §2.5/§3.1 pattern
  already applies inside CrystalOS.
- `_write_capability_gap`/`log_capability_gap`: embeds the query and writes to
  `crystal_capability_gaps` with the embedding — infrastructure for later clustering of "questions
  Crystal couldn't answer" (consumed by `scheduler.py::_cluster_capability_gaps`, confirmed present).
- Everything in this file is already fire-and-forget / fail-open by construction — this is a good
  existing example of the exact "fail-open on observability" principle the synthesis's §2.7 names as
  a *pattern worth adopting explicitly*; CrystalOS already does it here, just not as a *stated,
  tested* policy.

### 1.7 Insight Pipeline (`graphs/insights.py`) — verified via the dedicated research pass

Full detail is in the sub-agent transcript I commissioned for this file (5,781 lines, read
completely); key facts for this checklist:

- **18 nodes** (not 17 — see §1.0), linear chain with exactly one fan-out/fan-in
  (`embed` → {`metrics`, `extract_texts`} → `absa`), entry point `resolve_context`. No LangGraph
  conditional edges — all profile/skip branching is in-node early-return, including
  `node_publish`'s delegation to the plain function `node_publish_manual` for manual profiles (that
  function is *not* a separate graph node).
- **`resolve_context`** (line 768): 3-level settings COALESCE via `lib/insight_settings.
  load_insight_settings`, layered with caller `config_override` (highest precedence);
  `walk_parent_chain()` reads `insight_checkpoints_v2` (lane='automated') with legacy
  `survey_insight_checkpoints` fallback, never raises; a documented **FK-mismatch bug fix** —
  `is_v2_parent` gate prevents writing a legacy-table id into `insight_checkpoints_v2.
  parent_checkpoint_id`'s self-referencing FK (would hard-fail every checkpoint write for any survey
  whose only history predates the v2 migration); watermark + `new_response_ids` computation with a
  **below-threshold skip** (`stream_response_threshold`, unless bootstrap or `trigger == "milestone"`);
  profile-specific window/sample resolution for `refresh`/`manual_expert`/`manual_quick`; an
  **empty-window skip** for manual profiles with no resolved sample.
- **`delta_compute`** (line 3012): bootstrap always short-circuits to `meaningful_delta=True`;
  otherwise loads the prior blob via the *same* already-walked chain from `resolve_context` (a 2026-07-04
  fix — this node used to query `survey_insight_checkpoints` directly and would silently go blind if
  `STOP_LEGACY_CHECKPOINT_WRITE` were ever flipped); computes `delta_from_prior` via `compute_delta`
  and share-weighted `compute_topic_lifecycle` when parent topic-share data exists; `meaningful_delta`
  via `evaluate_meaningful_delta` (both imported from `tools/delta.py`, not re-verified in this pass).
- **Run profiles**: `_derive_profile(trigger, profile)` — explicit `profile` always wins; `trigger==
  "refresh"` → `refresh`; **legacy `trigger=="manual"` intentionally still means "force-regenerate the
  automated projection" (UI Refresh), not a manual report** — stays `automated_incremental` with
  `force_regenerate=True` for backward compatibility. This is a subtlety a naive harness "clean up the
  trigger/profile enum" refactor could easily break.
- **`publish`**: checkpoint-write gate is `meaningful_delta OR is_bootstrap OR is_tier_milestone`
  (milestone response counts, e.g. 10/40/100/250 — shared concept with the Progressive Tier System);
  `insights` table upsert with `ON CONFLICT (survey_id, insight_hash, time_window)`, preserving
  `user_state_json` (pins/thumbs); supersede logic is conditional on whether a fresh `report.*`
  insight exists this run (only non-report rows get superseded if the report step was skipped, so
  `report.*` rows "survive"). Legacy checkpoint write gated by `STOP_LEGACY_CHECKPOINT_WRITE`; v2 dual
  write gated by `INSIGHT_CHECKPOINTS_V2_ENABLED` (default True per CLAUDE.md) — legacy remains
  "source of truth," v2 write failure never fails the run. `node_publish_manual` (a plain function, not
  a graph node) hardcodes `meaningful_delta=False` for its own `insight_checkpoints_v2` (lane='manual')
  row — manual checkpoints never count toward retention/lifecycle "meaningful" logic — and never
  touches `insights`/`superseded_at` at all, confirming the "no supersede for manual" invariant in
  code, not just in CLAUDE.md prose.
- **Credit preflight**: `insights.py` itself contains **zero** credit-related code (confirmed via
  targeted grep during the research pass) — preflight (`credit_preflight()`, defined in
  `lib/insight_settings.py`, called from `main.py`'s HTTP handlers *before* the graph runs) is a
  read-only balance check; the module docstring states "CrystalOS does NOT debit... the backend owns
  debiting" verbatim. Automated silent-skip (`run_type == "automated_incremental"` and insufficient
  balance) returns `False` rather than raising; manual/refresh/custom raise `InsufficientCreditsError`
  → HTTP 402.
- **Heartbeat**: `_update_heartbeat(run_id)` called at the top of ~14 node bodies, updates
  `agent_runs.last_heartbeat_at`, never raises. No zombie-sweep code lives in this file — that's
  `scheduler.py::sweep_zombie_runs` (confirmed present), consuming the heartbeat this file writes.
- **Verified hard-invariant docstrings** (quoted in the sub-agent report, spot-checked by me):
  `node_resolve_context` "never crashes the pipeline... falls back to defaults"; `walk_parent_chain`
  "never raises — returns [] on any failure"; `node_ai_triggers` "never raises — a trigger-detection
  failure must not fail an otherwise-successful insight run"; the ABSA `_llm_raw` docstring explicitly
  documents **why** it avoids the shared circuit breaker (to keep ABSA failures from cascading into
  narrate/verify/evaluate for the whole pipeline) — this is exactly the kind of load-bearing, subtle
  reasoning a "formalize the tool-error contract" pass must read and preserve, not blanket-replace.

### 1.8 Custom Analysis (isolated graph) — verified via the dedicated research pass

`graphs/custom_analysis.py` (608 lines, read completely): the module docstring's five HARD ISOLATION
INVARIANTS are all independently confirmed enforced in code, not just documented:

1. **Never writes `insights` table** — the only INSERT function, `_insert_custom_insight`, targets
   `custom_report_insights` only; no `INSERT INTO insights`/`UPDATE insights` string appears anywhere
   in the file.
2. **Never supersedes** — `_insert_custom_insight`'s own docstring: "Immutable snapshot — no
   superseded_at, no ON CONFLICT update"; confirmed no `superseded_at` column write anywhere.
3. **`discover_topics` is genuinely read-only** — its signature (`tools/topics.py`) takes no DB
   connection/cursor parameter at all, structurally making a write from inside it impossible without
   opening its own connection (confirmed none does); `upsert_survey_topics` is a distinct function
   this module never imports.
4. **`trust_score` capped at 55 when `n < custom_analysis_min_n_for_nps`** (default 30, configurable
   per org/survey — not a hardcoded 30) — enforced by a single small function, `_cap_trust`, applied
   at exactly the two insight-construction call sites.
5. **No predictive layer** — enforced by omission: `_build_custom_insights` only ever emits
   `"layer": "descriptive"` or `"layer": "diagnostic"`; there is no guard/assertion that would catch a
   future accidental `"predictive"` emission — the invariant holds because no forecasting tool is
   imported, not because of an active check. **This is a latent fragility**: a future contributor
   adding a new insight type to this function could violate invariant 5 silently, with no test or
   runtime assertion catching it. Worth flagging as a concrete "add a guard, don't just document it"
   improvement independent of any harness adoption (see §2).
- Corpus capping: raw load at `2× custom_analysis_max_corpus` (widens the pre-filter pool), then
  `stratified_sample()` (shared with the automated pipeline's `manual_expert` mode, deterministic
  `seed=42`) if post-filter count still exceeds the cap.
- Credit preflight: zero credit code in this file either; `main.py`'s `/reports/custom/run` handler
  does the same read-only `credit_preflight(org_id, "custom", settings)` pattern as the automated/manual
  entry point, before the graph task is created.
- **`filter_spec.metric_types` and `filter_spec.narrative_depth` are accepted in the request schema but
  never read anywhere in this file** (confirmed by the sub-agent's full-file scan) — this is a
  documented-in-comment-but-not-implemented gap (the docstring even says `narrative_depth` is "consumed
  at narrate time," but there's no narrate-time consumer inside this module). Worth the team's
  awareness before assuming these filters do anything today.
- Error handling here is uniformly ad hoc (bare `try/except Exception: log-and-degrade`, no shared
  error taxonomy, one silent `except Exception: pass` with **no logging at all** around the
  `agent_runs` audit-status update) — see §2 for the simplification angle.

### 1.9 Skill-first survey creation/editing + the survey_skill_adapter boundary

Verified via the dedicated research pass on `lib/skill_survey_adapter.py` (127 lines):

- This file is a **pure shape-mapper**, not where the fallback decision lives. It raises `ValueError`
  on unmappable skill output (missing text, non-dict question) and lets Pydantic's
  `Question.model_validate` raise on true schema violations; it does **not** contain any
  try/except-and-fallback logic itself.
- The actual "not registered / eval fail / mapping error → fall back to legacy `call_agent`" decision
  lives in `agents/creator.py::_try_skill_creator` and `agents/copilot.py::_try_skill_copilot` — both
  wrap the skill-registry call + adapter call in one broad `try/except Exception`, returning `None` on
  any failure so the caller falls through to the legacy path. This confirms CLAUDE.md's claim that
  "output is identical downstream (all ID-fix / bias / logic guards still run)" — those guards
  (`fix_question_ids`, `check_survey_bias`, `validate_questions_semantic`, skip-logic destination
  checks) run in `agents/creator.py`/`agents/copilot.py` *after* the skill-vs-legacy branch merges,
  unconditionally, regardless of which path produced the output.
- **`skill_questions_to_models` is fail-fast, not best-effort-per-question**: a single bad question in
  a list aborts the whole conversion immediately (no partial success). Its own defensive
  `if not out: raise ValueError(...)` guard at the end is dead code given the current loop body — a
  minor, harmless simplification opportunity (see §2).

### 1.10 Thread continuity, rate limiting, Tag Report, retention, Progressive Tier System

- **Thread continuity** (`agents/crystal.py::get_or_create_thread`/`append_to_thread`): UPSERT by
  `(org_id, user_id, survey_id, scope)`; resets if `stale_days >= CRYSTAL_THREAD_INACTIVITY_TTL_DAYS`
  (7); `append_to_thread`'s SQL caps the JSONB array at 100 messages via a `CASE WHEN
  jsonb_array_length(messages) >= 100 THEN (messages - 0) || ...` (drops oldest, appends newest) — this
  is a real, enforced 100-message cap, not just a doc claim.
- **Rate limiting** (`_crystal_rate_count`): Redis `INCR` + `EXPIRE 60` per `crystal:{org_id}:rpm` key,
  hard cap 10/min; **fails open** (returns 0, i.e. "not rate limited") if Redis is unavailable — a
  deliberate availability-over-strictness choice.
- **Tag Report tools**: confirmed present in `TOOL_REGISTRY` (`list_tags`, `get_tag_report`,
  `get_tag_report_trail`, `propose_view_tag_report`, `propose_generate_tag_report`) and in
  `TOOL_EXECUTORS`; `get_tools_for_scope("tag")` includes `group`-scoped tools too, matching CLAUDE.md.
  `tag-analyst`'s own EVALS.md gives its highest single criterion weight (0.90 threshold, weight 20) to
  **"trust-layer fidelity"** — never conflating a single-survey-sourced finding with a tag-wide claim —
  confirmed as a real, code-enforced eval gate, not just SKILL.md prose.
- **Retention/compaction** (`scheduler.py::run_retention_job`, confirmed present at line 773) and
  **Progressive Tier System** (`consumers/response_stream.py::should_trigger_progressive_tier`,
  confirmed at line 68, plus the separate, lighter response-tagging sweep
  `_run_tagging_sweep`/`_should_trigger_tagging` at lines 154/167) — function names and structure
  match CLAUDE.md's description; I did not do a full line-by-line read of these two files (budget
  triage — see §6 open questions), but existence and naming are confirmed via direct grep of the
  actual source, not just CLAUDE.md prose.

### 1.11 Entry points (from `main.py`, read in full)

All gated by `require_internal_key` (`X-Internal-Key` header) except `/health`/`/metrics`:
`/orchestrate` (+`/cancel`, `/status`, `/refine`, `/skip-logic`, question CRUD,
`/apply-recommendation/{action_id}`), `/insights/generate`, `/insights/runs` (manual/refresh, Phase 3),
`/topics/backfill`, `/workflows/parse-nl`, `/reports/custom/run`, `/groups/insights/generate`,
`/tag-reports/generate`, `/responses/generate`, `/prism/map`+`/taxonomy`+`/parity`, `/insights/crystal`
(non-streaming), `/insights/crystal-support`, `/insights/crystal/stream` (SSE), `/agents/registry`,
`/internal/checkpoint-blob`+`/checkpoint-read-url` (path-traversal-guarded via `Path.is_relative_to`,
explicitly chosen over `str.startswith()` per an inline comment about a sibling-directory bypass),
`/api/admin/crystal/dlq`+`/dlq/replay`. Startup validation (`main.py:44-61`): model-ID sanity check
runs in **all** envs; in prod, missing required env vars or an unchanged default
`AGENTS_INTERNAL_KEY` **raises at import time** (hard-fails startup) — this is itself a fail-fast
gate already in the codebase today, directly analogous to what the harness synthesis's Tier-1 item #1
proposes formalizing further.

---

## 2. Simplification opportunities (independent of the harness research)

Concrete, file/function-level, found by direct reading — these would shrink or de-duplicate code
regardless of any harness-pattern adoption:

1. **`node_verify`'s trust-score demotion has three different magic-number caps for the same concept**
   (`graphs/insights.py:4092-4150`): skill-runtime hybrid scorer caps at 45 (fail) or 60 (flag); legacy
   LLM-verifier caps at 55; the outer "verification service unavailable" except-branch caps at 65.
   Four different numbers for "we couldn't fully verify this insight, demote its trust" with no shared
   constant. Consolidate into one named constant table (`VERIFY_DEMOTION_CAPS = {...}`) — pure
   deduplication, zero behavior change if done carefully.

2. **`node_ingest`'s use of a control-flow exception (`_ManualSampleLoaded`) to short-circuit the
   stratified-sampling block** (`graphs/insights.py:203-206`) is a real but unusual pattern — using
   raise/except for a *known, expected* branch rather than a boolean early return. It's contained and
   documented, but a straightforward `if resolved_profile in _MANUAL_PROFILES_WITH_PRESAMPLE: ... return`
   would be equally correct and easier for a new reader to trace without hunting for where the
   exception is caught.

3. **`skill_survey_adapter.py::skill_questions_to_models`'s trailing `if not out: raise ValueError(...)`
   is dead code** given the loop's current fail-fast-per-item behavior (any bad question raises
   immediately, so `out` can never be empty from a non-empty input without already having raised).
   Harmless, but a stale defensive check worth removing or converting into a comment explaining why
   it's now unreachable.

4. **`dispatch_tool` (`crystal/tools.py:3799`) does not itself guarantee the `{"error": ...}` tool-error
   contract** — it dispatches to the executor and lets any *uncaught* exception from a poorly-written
   executor propagate to the caller, relying on every individual `execute_*` function to have
   remembered its own try/except. I spot-checked ~15 `execute_*` functions and all of them do have
   this wrapper, but the convention is enforced by discipline/copy-paste, not by `dispatch_tool` itself.
   This is simultaneously the **exact gap the harness synthesis's Tier-1 item #3 (formalize the
   tool-error contract) would close**, and a place where — even without adopting anything from the
   harness research — a one-line `try/except` wrapper inside `dispatch_tool` itself would remove the
   "did every executor remember to catch its own exceptions" trust requirement and make the contract
   structurally guaranteed rather than convention-following. Cheapest, highest-leverage single change
   I found in this whole assessment.

5. **`custom_analysis.py` has an inconsistent error-shape between its own two failure paths**: the
   survey-not-found early return uses `{"error": "survey not found"}` while the outer exception
   handler uses `{"status": "failed", "error": str(exc)}` — two different envelope shapes for
   conceptually the same "this run failed" outcome, with no shared error-code taxonomy between them.
   A tiny, local fix (one shared `_failure_result()` helper) would remove the inconsistency without
   touching anything else.

6. **`custom_analysis.py`'s `agent_runs` audit-status update swallows exceptions with a bare
   `except Exception: pass` and *no logging at all*** (both the success-path and failure-path variants)
   — the one spot in that file with strictly weaker error visibility than everywhere else (every other
   except-block in the file at least logs at `warning` or `debug`). A one-line `logger.debug(...)` add
   would bring it in line with the rest of the file's own conventions.

7. **`~30+ near-identical "never fails the run" try/except/log blocks scattered across
   `graphs/insights.py`** (per the sub-agent's count) manually reimplement the same "log and degrade
   gracefully" idiom at each call site rather than through one shared decorator/context-manager. This
   is real duplicated logic, independent of any harness decision — a `@best_effort(logger, event_name)`
   decorator (or equivalent) would collapse dozens of 3-5 line blocks into one line each, and would
   make the *logging level and event-name convention* consistent (today it varies: some are
   `logger.warning`, some `logger.debug`, one is silent — see item 6).

8. **`TOOL_PERMISSION_MAP` covers only 4 of ~60 registry tools** (`crystal.py:681-686`) and is only
   consulted by the legacy ReAct prompt-filtering path, not by the skill-first dispatch path. This
   isn't strictly "duplicated logic" but it is dead-end/inconsistent scope — either the intent is that
   most tools are permission-open by design (in which case this is fine and just under-documented), or
   this is an incomplete migration that never got finished when the skill-first path was added. Worth
   a deliberate decision either way rather than leaving it ambiguous — see §4 for the risk framing.

---

## 3. Improvement opportunities (tied to specific Crystal-harness synthesis patterns)

For each, I name the exact file/function the pattern would touch, and size the change concretely
based on what I actually read (not a generic estimate).

1. **Tier 1 #1 — fail-fast identity/context gate** (00-SYNTHESIS.md §3, item 1). CrystalOS resolves
   `org_id`/`user_id`/`survey_id`/permissions in several different places today: `_build_ctx`
   (`agents/crystal.py:890`, Crystal's own context builder), `check_survey_access`
   (`main.py`, called per-endpoint before invoking the agent), and `_require_run`
   (`main.py:220`, the orchestration-run path's own org-scoping check via `db.get_run_by_id`). These
   are three genuinely different resolution shapes for three different surfaces (Crystal chat, survey
   creation/editing runs, insight pipeline runs) — **a single unifying gate would need to either (a)
   accept that "identity resolution" means three different things in this codebase and build three
   thin adapters into one shared validator, or (b) risk collapsing distinctions that exist for a
   reason** (e.g. `_require_run` intentionally 404s rather than 400s when the run exists but belongs to
   a different org — a security-relevant distinction that a generic gate must preserve). Concrete
   touch points: `agents/crystal.py::_build_ctx`, `main.py::_require_run`, `main.py::check_survey_access`
   call sites (both `crystal_chat` and `crystal_stream_endpoint`). Effort: real, not "mostly relocating"
   as the synthesis's estimate suggests for the general case — CrystalOS's three surfaces don't share
   one context shape today, so building the gate is more design work than the synthesis's generic
   sizing implies.

2. **Tier 1 #2 — provenance stamping**. Cheap and safe, confirmed by direct reading: `TurnEvent`
   (`turn_publisher.py`) already carries `skill_name`, but not a CrystalOS package version. Adding
   `importlib.metadata.version("crystalos")` (or a `__version__` constant if not packaged) to
   `TurnEvent` and to the `crystal_debug_traces` write in `main.py`'s debug-trace block would be a
   small, additive, backward-compatible column add — genuinely low risk, exactly as the synthesis
   estimates.

3. **Tier 1 #3 — formalize the tool-error contract**. As noted in §2 item 4, this is both a
   simplification *and* a harness-pattern adoption — the cheapest, safest possible starting point for
   any rearchitecture effort, because `dispatch_tool` (`crystal/tools.py:3799`) is the single existing
   choke point every tool call already passes through. Wrapping the executor call in a
   `try/except Exception as exc: return {"error": str(exc)}` there, plus a repo-wide `assert_ok()` test
   helper, would formalize a convention that's already ~95% true by discipline into something
   structurally guaranteed. Regression risk is close to zero **provided** the wrapper preserves the
   exact `{"error": str(exc)}` shape every executor already independently produces (a differently-
   shaped envelope would break `_react_plan_tools`'s `"error" not in result` checks scattered through
   `crystal.py`).

4. **Tier 2 #7 — an `applied_filters`-equivalent audit object**. CrystalOS's closest existing analog
   is each tool result's own `args` dict, already threaded through `tool_results` in `_react_plan_tools`/
   `_run_skill_stream` and rendered as SSE `observation` events. Building a canonical, normalized
   filter-tree shape would touch: `agents/crystal.py::_build_tool_observations` (currently formats args
   as a flat `k=v` string per tool call, not a structured tree) and the `CrystalOutput` schema (would
   need a new optional field, e.g. `applied_filters: list[dict] | None = None`, emitted even when
   empty per the synthesis's own recommendation). The design decision the synthesis flags as needed
   (canonical shape across data sources) is real: CrystalOS's tools query wildly different backends —
   `survey_topics` rows, `responses` rows, `insight_checkpoints_v2` chains, cross-survey tag rollups —
   and today's `args` dicts have no shared vocabulary for "what was actually filtered" (e.g.
   `get_segment_breakdown`'s `segment_question_id` vs. `get_tag_report`'s `tag_id` vs.
   `analyze_group_coverage`'s `tag_ids` are three different shapes for "what scope did this query
   run against"). This is genuinely Tier 2, not Tier 1 — the design work is non-trivial.

5. **Tier 2 #8 — validator-script-paired-with-eval-gate**. CrystalOS already has one clean example of
   exactly this shape *outside* the skill-runtime retry loop: `custom_analysis.py`'s `_cap_trust`
   function (deterministic Python validator applied post-hoc to LLM-influenced trust scores). The
   *missing* piece the synthesis's pattern would add is wiring a validator into `SkillRuntime`'s
   existing retry-with-failure-context loop (`lib/skill_runtime.py:176-208`) so a skill with a
   provably-correct sub-check (e.g. `compliance-scanner`'s deterministic scoring rubric — "start at
   100, deduct -25/critical capped at -50..." — is currently graded by an LLM judge against
   `compliance_score is integer 0-100`, not cross-checked against the rubric's own arithmetic) gets a
   real deterministic re-check, not just an LLM-judged "is this plausible" pass. `compliance-scanner`
   is the single best pilot candidate I found for this pattern — its rubric is already fully specified
   in prose (SKILL.md) and just needs the arithmetic extracted into a small Python function the
   `_check_evals` path calls.

6. **Tier 1 #5 — negative/counter-examples in EXAMPLES.md**. Confirmed empirically (§1.2): 4 of 5
   sampled skills have empty auto-generated EXAMPLES.md placeholders; only `workflow-analyst`'s is
   populated, and even there the "negative examples" are within-skill behavioral guardrails (don't
   fabricate a trigger), not cross-skill routing counter-examples. This is real, actionable, low-risk
   content work exactly as the synthesis frames it — but the team should know the starting point is
   closer to zero than "some skills have this, some don't."

---

## 4. Risks / what could break

Risks specific to what I actually read, ranked by how subtle/undocumented the current behavior is:

1. **The `TOOL_PERMISSION_MAP` coverage gap (§2 item 8) is a security-adjacent inconsistency that
   predates any harness discussion, and a fail-fast "identity/permission gate" migration could either
   fix it or silently formalize it as intended behavior without anyone deciding that on purpose.** If
   the team builds a single early permission gate, it will force an explicit decision about whether
   the other ~56 tools are *intentionally* permission-open (fine) or an oversight (needs
   `TOOL_PERMISSION_MAP` entries added) — today that decision is implicit and undocumented. This should
   be resolved as its own small decision, not inherited silently by whatever gate design wins.

2. **The two hard-force routing bypasses (Wave 15 page-context, Wave 18 message-content regex) for
   `workflow-analyst` are real production logic living entirely in `agents/crystal.py`
   (`_resolve_forced_skill`), not in the semantic router.** Any "named hook point" refactor of routing
   (harness synthesis Tier 2 #10) must explicitly account for these two bypasses as first-class
   pre-router checks, not treat `skill_registry.find()` as the single source of truth for "which skill
   handles this turn." Missing this would regress the exact bug (workflow-taxonomy questions
   hallucinating against `crystal-analyst`) Wave 18 was built to fix.

3. **`_normalize_proposal`'s turn-scoped id-minting logic (`agents/crystal.py:974`) has a documented,
   non-obvious dual requirement** — unique across turns, stable within one proposal's own
   emit→confirm→execute lifecycle — tied to a specific prior bug and a specific migration
   (`20260806000001`). A provenance-stamping change that touches how ids are minted anywhere in this
   path (e.g. adding a harness-version-stamped id format) must preserve both properties exactly, or it
   will reintroduce the original dedup bug this logic was written to fix. This is the single most
   "looks simple, isn't" piece of code in the action-proposal path.

4. **Custom Analysis's invariant 5 ("no predictive layer") is enforced by omission, not by an active
   guard** (§1.8). It currently holds because no forecasting tool is imported into
   `_build_custom_insights`. Any refactor that touches this function (harness-motivated or not) has no
   test or runtime assertion that would catch a regression here — a new insight-type addition could
   silently violate the invariant. This is worth a real guard (e.g. an assertion on `layer` values at
   the point insights are inserted) independent of the harness decision, but especially important to
   add *before* any broader refactor touches this file.

5. **The manual `trigger == "manual"` → `automated_incremental` + `force_regenerate=True` backward-
   compatibility mapping in `_derive_profile`** (§1.7) is exactly the kind of "looks like dead/confusing
   code, actually load-bearing" logic a harness cleanup pass could accidentally "simplify" away,
   breaking every existing caller that still sends the legacy `trigger='manual'` value expecting
   today's UI-Refresh behavior, not a manual-report run.

6. **The credit-preflight "backend owns debiting" invariant is enforced by absence, not by a shared
   contract type** — both `insights.py` and `custom_analysis.py` simply never import/call anything
   debit-shaped. There's no code-level guard (e.g. a `ReadOnlyCreditContext` type) that would make a
   future contributor's accidental debit call fail loudly rather than just be a code-review catch. Low
   probability, high blast-radius (double-debit race) if ever violated — worth a structural guard
   regardless of the harness decision, given how explicitly the code comments already flag this as a
   deliberate, previously-reasoned-about design choice.

---

## 5. The single riskiest area to touch

**`agents/crystal.py`'s three-layer fallback chain plus its two independent hard-force routing
overrides, combined with `_normalize_proposal`'s turn-scoped id-minting** — specifically the code
spanning `_run_skill_stream` (line 1955), `_resolve_forced_skill` (line 1933), and `_normalize_proposal`
(line 974).

Why this beats the other candidates: the Insight Pipeline (`graphs/insights.py`) is also enormously
subtle, but its subtlety is almost entirely *documented in place* — nearly every non-obvious decision
I found there has an explicit comment naming the bug it fixes and the date it was fixed (the FK-mismatch
gate, the `is_bootstrap` legacy-parent fix, the `_llm_raw` circuit-breaker isolation). `agents/crystal.py`'s
routing/fallback/id-minting logic is *equally* subtle but the reasoning is more scattered across
multiple functions and two different "Wave" feature additions (15 and 18) layered on top of an older
design, with the actual behavioral contract only reconstructable by reading `_resolve_forced_skill`,
`_run_skill_stream`, `_normalize_proposal`, and the CLAUDE.md action-proposal table *together*. It is
also the piece of code every single harness pattern under discussion would touch in some way (fail-fast
gates touch `_build_ctx`; named hook points touch the whole `_run_skill_stream` shape; provenance
stamping touches `_fire_telemetry`/`_normalize_proposal`'s id logic) — meaning it's not just subtle, it's
subtle *and* the highest-traffic surface for every proposed change. Test coverage exists (per CLAUDE.md's
~1400-test claim) but I did not independently verify test *density* specifically against this file's
routing/fallback branches (see open question in §6) — that verification should happen before anyone
touches this code.

---

## 6. My recommendation

**Adopt Tier 1 selectively and incrementally; do not rearchitect; treat Tier 2/3 as genuinely deferred.**

From the deepest-codebase-knowledge vantage point specifically: CrystalOS's existing structure
(`SkillRuntime`'s eval gate, the action-proposal normalize boundary, `BrandContext`/permission
resolution, the semantic router with its two documented hard-force exceptions) is not "ad hoc code that
happens to work" — it is, almost everywhere I read, **deliberately reasoned-about code with comments
that name the specific prior bug or design tradeoff each piece of subtlety exists to address**. That is
the opposite of what a harness rearchitecture is usually justified by (untested, accidental complexity).
The genuine gaps I found — `dispatch_tool`'s non-guaranteed error contract, the `TOOL_PERMISSION_MAP`
coverage gap, the missing runtime guard on custom-analysis invariant 5, ~30 duplicated try/except
blocks in `insights.py` — are all small, local, independently fixable, and **do not require touching the
routing/fallback/proposal-normalization core** at all. I would start with the two cheapest Tier 1 items
that are also independent simplifications regardless of the broader question (formalize the tool-error
contract via `dispatch_tool`; provenance-stamp `TurnEvent`), ship those, and only then decide whether
Tier 2's named-hook-point refactor of `SkillRuntime.execute()`/`_run_skill_stream` is worth the risk to
the single riskiest area identified in §5 — which I'd want backed by the regression-test-density
verification noted below before anyone touches it.

---

## 7. Open questions for the rest of the team

1. **Test density on the routing/fallback branches specifically** (not just "1400 tests exist somewhere"):
   does the test suite actually pin `_resolve_forced_skill`'s two force conditions, the three-layer
   fallback chain's outermost double-fallback in `main.py`'s `event_stream()`, and `_normalize_proposal`'s
   turn-scoped id stability guarantee? If not, that's a prerequisite for touching §5's area at all,
   independent of which harness pattern is chosen. (Priya/Dr. Reyes — this feels like your lane to
   confirm via the actual test files, which I didn't audit.)
2. **Is `TOOL_PERMISSION_MAP`'s 4-of-60 coverage intentional?** (§2 item 8, §4 item 1) — I could not
   resolve this from source alone; it needs a product/security decision, not just a code fix.
3. **Are `BrandContext.max_tool_turns`/`thread_ttl_days`/`progressive_tiers` (declared but,
   as far as I found, unconsumed by `crystal.py`) dead fields, or is there a consumer I missed
   elsewhere in the codebase (e.g. a brand-admin config UI) that I didn't have budget to trace?** Worth
   a quick grep-confirmation before anyone assumes per-brand tuning of these values works today.
4. **For Dana (backend)**: does the Node backend's `agentsClient.js` or any caller depend on the
   *current* three-tier error-shape inconsistency I found in `custom_analysis.py` (§2 item 5) — i.e.,
   would unifying the error envelope there require a corresponding backend change, or is the backend
   already normalizing on its side regardless of CrystalOS's shape?
5. **For Jordan (frontend)**: `_normalize_proposal`'s id doubles as `CrystalPanel.tsx`'s `proposalKey`
   per the docstring I read — if any harness-motivated change touches id-minting, does the frontend
   have any test that would catch a stability regression, or does that risk live entirely on the
   backend/CrystalOS side today?
