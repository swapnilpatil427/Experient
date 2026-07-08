"""Natural-language → structured workflow parsing.

Shared core for TWO call sites that both need "plain English → a workflow the
engine can run":
  1. `POST /workflows/parse-nl` (main.py) — the dedicated NL builder page
     (BUILDER_SPEC_WAVE2.md §2.1).
  2. `execute_propose_workflow()` (crystal/tools.py) — the legacy in-chat
     "propose_workflow" Crystal tool.

Both must emit the SAME modern engine shape (`nodes`/`edges` graph, matching
`app/src/lib/workflowCanvas.ts`'s `EngineNode`/`EngineEdge`) rather than two
independently-drifting formats. This module is the single source of truth for
that conversion; callers adapt the result to their own response envelope.

Design:
  - One structured-output LLM call (via `lib/openrouter.call_agent`, reusing
    the `crystal` model — no new AgentName routing entry needed) turns free
    text into a small draft spec (trigger category + rough field/op/value +
    action list + a name/description Crystal proposes).
  - The draft is then mapped onto the CALLER-SUPPLIED registry (never a
    hand-copied Python constant — the registry is passed in so there is
    exactly one source of truth: `backend/src/lib/workflowRegistry.ts`,
    forwarded by the Node proxy route). Any trigger/action/condition-field
    the LLM proposes that is NOT present in the supplied registry is dropped
    (and pushes a warning + lowers confidence) rather than ever being
    returned — the hard invariant the spec requires.
  - No LangGraph subgraph: this is a single bounded LLM call with
    deterministic post-validation, not a multi-step reasoning pipeline. A
    subgraph would add orchestration overhead without buying anything a plain
    call + validator doesn't already give us.
"""
from __future__ import annotations

import re
import uuid
from typing import Any

from pydantic import BaseModel, Field

from crystalos.lib.logger import logger
from crystalos.lib.openrouter import call_agent, AgentOutputError, OpenRouterError
from crystalos.lib.circuit_breaker import CircuitBreakerOpen

# ── Confidence thresholds (tunable — see WORKFLOW_SIGNAL_CONTRACT.md for the
# broader AI-trigger threshold design; these two are specific to NL parsing) ──
#
# >= LOW_CONFIDENCE_THRESHOLD  → returned as a normal 200 (frontend still
#   shows Medium/High badge tiers above this per BUILDER_SPEC_WAVE2.md §2.4b).
# <  LOW_CONFIDENCE_THRESHOLD  → still a 200, but the frontend routes it to
#   the "tentative, no Create button" state (spec §2.5A) rather than the
#   confirm-card.
# <  UNPARSEABLE_THRESHOLD     → not even a tentative structure is worth
#   returning; the endpoint responds 422 instead.
LOW_CONFIDENCE_THRESHOLD = 0.6
UNPARSEABLE_THRESHOLD = 0.25

# Registry-drift penalty: how much confidence is lost per hallucinated
# trigger/action/field that had to be dropped. Multiple drops stack
# (multiplicatively) so a draft that invents e.g. two actions out of three
# ends up well below LOW_CONFIDENCE_THRESHOLD rather than barely dipping.
_REGISTRY_DRIFT_PENALTY = 0.35


class WorkflowNLTriggerDraft(BaseModel):
    trigger_type: str = Field(description="Best-guess registry trigger `type` string, e.g. 'score.nps_drop'")


class WorkflowNLConditionDraft(BaseModel):
    field: str = Field(description="Best-guess registry condition field, e.g. 'nps'")
    op: str = Field(description="Best-guess registry operator, e.g. 'lt'")
    value: str = Field(description="Comparison value as a string; numeric strings are coerced downstream")


class WorkflowNLActionDraft(BaseModel):
    action: str = Field(description="Best-guess registry action, e.g. 'notify.slack'")
    config: dict[str, Any] = Field(default_factory=dict, description="Best-effort action config, e.g. {'channel': '#cx'}")
    assumed: bool = Field(default=False, description="True if this action's config was inferred, not stated by the user")
    assumption_note: str | None = Field(default=None, description="Human-readable note if assumed=true, e.g. 'Assumed Slack channel #customer-success'")


class WorkflowNLDraft(BaseModel):
    """Raw LLM output — registry-unvalidated. `parse_workflow_nl` validates this
    against the caller-supplied registry before it ever reaches a caller."""
    name: str = Field(description="Short, human-readable workflow name (<= 60 chars)")
    description: str = Field(description="One-sentence restatement of what the workflow does")
    trigger: WorkflowNLTriggerDraft
    conditions: list[WorkflowNLConditionDraft] = Field(default_factory=list)
    actions: list[WorkflowNLActionDraft] = Field(min_length=1)
    confidence: float = Field(ge=0.0, le=1.0, description="Model's own confidence that this correctly captures the user's intent")
    warnings: list[str] = Field(default_factory=list, description="Any assumptions or ambiguities worth flagging to the user")
    unparseable: bool = Field(default=False, description="True if the description has no discernible trigger+action pattern at all")
    unparseable_reason: str | None = Field(default=None)
    scope_hint: str | None = Field(
        default=None,
        description=(
            "Best-guess free-text NAME of a specific survey or tag mentioned in the "
            "description (e.g. 'for the Onboarding Survey' -> 'Onboarding Survey'), or "
            "null if no specific survey/tag was named. The model proposes a NAME ONLY — "
            "it does not know or guess whether it's a survey vs. a tag, and does not "
            "invent an id; the caller resolves the name against the real org catalog."
        ),
    )


# ── Fallback registry (legacy chat-tool path only) ────────────────────────────
# `execute_propose_workflow()` (crystal/tools.py) is invoked mid-conversation by
# the Crystal ReAct/skill tool loop — unlike the HTTP endpoint, it has no Node
# request to forward a live registry from. Rather than fail closed whenever the
# chat tool is used, it falls back to this small, deliberately conservative
# mirror of the entries in `backend/src/lib/workflowRegistry.ts` that are
# `live: true` (safe to actually create) as of the last time this was updated.
# This is a KNOWN drift risk (flagged in this wave's report) — the registry
# HTTP path (`POST /workflows/parse-nl`) is always preferred and always
# authoritative; this fallback exists only so the chat tool degrades to "a
# smaller but still-valid catalog" instead of "cannot function at all."
FALLBACK_REGISTRY: dict[str, Any] = {
    "triggers": [
        {"type": "survey.response_received", "category": "Survey", "label": "Response received"},
        {"type": "score.nps_drop", "category": "Score", "label": "NPS dropped"},
        {"type": "score.nps_rise", "category": "Score", "label": "NPS rose"},
        {"type": "crystal.insight_ready", "category": "Crystal", "label": "Insight ready"},
        {"type": "crystal.anomaly_detected", "category": "Crystal", "label": "Anomaly detected"},
        {"type": "alert.fired", "category": "Alerts", "label": "Alert fired"},
    ],
    "conditionFields": [
        {"field": "nps", "label": "NPS score", "kind": "number"},
        {"field": "csat", "label": "CSAT score", "kind": "number"},
        {"field": "sentiment", "label": "Crystal sentiment", "kind": "string"},
        {"field": "text", "label": "Response text", "kind": "string"},
        {"field": "topic", "label": "Crystal topic", "kind": "string"},
        {"field": "severity", "label": "Alert/Crystal severity", "kind": "string"},
    ],
    "conditionOperators": ["eq", "neq", "gt", "lt", "gte", "lte", "between", "contains", "not_contains", "in", "not_in"],
    "actions": [
        {"action": "notify.in_app", "category": "Notify", "label": "In-app notification", "live": True},
        {"action": "notify.slack", "category": "Notify", "label": "Slack message", "live": True},
        {"action": "notify.email", "category": "Notify", "label": "Email", "live": True},
        {"action": "notify.webhook", "category": "Notify", "label": "Webhook", "live": True},
        {"action": "data.tag_responses", "category": "Data", "label": "Tag responses", "live": True},
        {"action": "jira.create_issue", "category": "Integration", "label": "Create Jira issue", "live": "env"},
        {"action": "zendesk.create_ticket", "category": "Integration", "label": "Create Zendesk ticket", "live": "env"},
    ],
}


_SYSTEM_PROMPT = """You are Crystal, translating a plain-English workflow automation request into a \
structured draft. You will be given the description AND the exact catalog of valid triggers, \
condition fields/operators, and actions — you MUST only choose from that catalog. If the best match \
is imperfect, pick the closest catalog entry and add a warning explaining the substitution rather than \
inventing a new type/field/action name.

Respond in JSON matching this shape exactly:
{
  "name": "short workflow name",
  "description": "one sentence restating the workflow",
  "trigger": {"trigger_type": "<one of the catalog trigger types>"},
  "conditions": [{"field": "<catalog field>", "op": "<catalog operator>", "value": "<string>"}],
  "actions": [{"action": "<catalog action>", "config": {}, "assumed": false, "assumption_note": null}],
  "confidence": 0.0-1.0,
  "warnings": ["..."],
  "unparseable": false,
  "unparseable_reason": null,
  "scope_hint": null
}

Rules:
- `conditions` may be an empty list if the trigger alone fully describes when to fire (e.g. "on every new response").
- `actions` must have at least one entry.
- If a value like a channel, recipient, or ticket project isn't stated, choose a sensible default, set that \
action's `assumed: true`, and add both an `assumption_note` on the action AND a matching entry in the \
top-level `warnings` list.
- Lower `confidence` when: the trigger is ambiguous, no condition value was given for a threshold-style \
trigger, or more than one action had to be assumed.
- If the description does not describe any recognizable trigger+action automation at all (e.g. it's a \
question, or unrelated to workflows), set `unparseable: true`, explain briefly in `unparseable_reason`, \
and still fill `trigger`/`actions` with your best guess (they will be ignored).
- `scope_hint`: if the description names a SPECIFIC survey or tag (e.g. "for the Onboarding Survey", \
"responses tagged VIP"), set `scope_hint` to that name exactly as written, as plain text — do not guess \
whether it's a survey or a tag, and do not invent an id. If no specific survey/tag is named (the request \
applies org-wide, e.g. "when any survey gets a low NPS score"), set `scope_hint: null`. When in doubt, \
prefer `null` over guessing a name."""


def _registry_lookup(registry: dict[str, Any]) -> tuple[set[str], set[str], set[str]]:
    """Extract the valid trigger types / condition fields / action names from the
    caller-supplied registry payload (shape mirrors `workflowRegistry.ts`'s
    `RegistryResult`: {triggers: [{type,...}], conditionFields: [{field,...}],
    actions: [{action,...}]})."""
    triggers = {
        t.get("type") for t in (registry.get("triggers") or [])
        if isinstance(t, dict) and t.get("type")
    }
    fields = {
        f.get("field") for f in (registry.get("conditionFields") or [])
        if isinstance(f, dict) and f.get("field")
    }
    actions = {
        a.get("action") for a in (registry.get("actions") or [])
        if isinstance(a, dict) and a.get("action")
    }
    return triggers, fields, actions


def _scope_catalog_lookup(registry: dict[str, Any]) -> tuple[dict[str, str], dict[str, str]]:
    """Extract {lowercased name: id} maps for the registry's `surveys`/`tags`
    lists (Wave 12 scope addition — BUILDER_REDESIGN_V2_SCOPE.md). Shape:
    {surveys: [{id, name}], tags: [{id, name}]}, mirroring
    `backend/src/schemas/workflows.ts`'s `scopeSurveyId`/`scopeTagId` (both real
    UUIDs, per `SurveyTag`/`Survey` types) — never plain-string tags.

    Both lists are OPTIONAL on the registry payload (older callers / the legacy
    chat-tool's FALLBACK_REGISTRY won't have them) — missing/malformed entries
    are simply excluded rather than raising, so scope resolution degrades to
    "no match" rather than crashing.
    """
    surveys = {
        s["name"].strip().lower(): s["id"]
        for s in (registry.get("surveys") or [])
        if isinstance(s, dict) and s.get("id") and isinstance(s.get("name"), str) and s["name"].strip()
    }
    tags = {
        t["name"].strip().lower(): t["id"]
        for t in (registry.get("tags") or [])
        if isinstance(t, dict) and t.get("id") and isinstance(t.get("name"), str) and t["name"].strip()
    }
    return surveys, tags


def _resolve_scope_hint(
    scope_hint: str | None,
    surveys_by_name: dict[str, str],
    tags_by_name: dict[str, str],
) -> tuple[str, str | None, str | None, str | None]:
    """Resolve a free-text `scope_hint` against the REAL org surveys/tags.

    Returns (scope_type, scope_survey_id, scope_tag_id, drift_warning).
    `drift_warning` is None unless the LLM proposed a hint that matched
    nothing — that (and only that) is a genuine hallucination worth a warning
    + confidence penalty, same severity class as a hallucinated trigger/action.

    Matching is deliberately conservative — case-insensitive EXACT match first;
    if no exact match, a substring match is allowed ONLY when it is unambiguous
    (exactly one candidate contains the hint, or the hint contains exactly one
    candidate's full name). Any ambiguity (multiple candidates could match, or
    both a survey AND a tag match) is treated as NO match — under-matching to
    org scope is always safer than guessing the wrong survey/tag, since scope
    determines what real data a workflow acts on.

    No hint given -> ('org', None, None, None) with NO warning: this is the
    normal case (most workflows are org-wide), not a drift event, and is
    byte-identical to pre-Wave-12 behavior.
    """
    if not scope_hint or not scope_hint.strip():
        return "org", None, None, None

    hint = scope_hint.strip().lower()

    def _match(catalog: dict[str, str]) -> str | None:
        if hint in catalog:
            return catalog[hint]
        candidates = {
            name: cid for name, cid in catalog.items()
            if hint in name or name in hint
        }
        if len(candidates) == 1:
            return next(iter(candidates.values()))
        return None

    survey_match = _match(surveys_by_name)
    tag_match = _match(tags_by_name)

    # Both a survey and a tag matched -> genuinely ambiguous, refuse to guess.
    if survey_match and tag_match:
        survey_match = None
        tag_match = None

    if survey_match:
        return "survey", survey_match, None, None
    if tag_match:
        return "tag", None, tag_match, None

    # Proposed but unmatched -> hallucination, same class as a bad trigger/action.
    return "org", None, None, f'"{scope_hint}" did not match any survey or tag — scope defaulted to org-wide.'


def _slugify_name(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or f"workflow-{uuid.uuid4().hex[:8]}"


def _coerce_value(v: str) -> Any:
    if v is None or v == "":
        return v
    try:
        if "." in v:
            return float(v)
        return int(v)
    except (TypeError, ValueError):
        return v


def _format_catalog(registry: dict[str, Any]) -> str:
    """Render the caller-supplied registry as a compact, LLM-readable catalog
    block: one "type: label" line per trigger/field/action, using the EXACT
    strings `_draft_to_engine_graph` validates against (`_registry_lookup`
    pulls from this same registry). This is the fix for the bug where
    `_SYSTEM_PROMPT` claimed the model would be "given the exact catalog" but
    no catalog was ever actually included in any message — the model was
    guessing generic/training-data identifiers (e.g. "schedule",
    "email_report") instead of this project's real registry strings
    (`time.schedule`, `notify.email`).

    Format is deliberately a plain "type (label)" line per entry rather than
    the raw registry JSON verbatim — cheaper (no repeated key names/braces per
    entry) and at least as easy for the model to copy an exact string from.
    The live catalog (`backend/src/lib/workflowRegistry.ts`) is small and
    bounded (13 triggers, 8 condition fields, ~15 actions as of this writing)
    so even with labels this adds well under 1KB to the prompt — not a
    runaway cost.
    """
    triggers = registry.get("triggers") or []
    fields = registry.get("conditionFields") or []
    operators = registry.get("conditionOperators") or []
    actions = registry.get("actions") or []

    trigger_lines = "\n".join(
        f'- {t.get("type")} ({t.get("label")})'
        for t in triggers if isinstance(t, dict) and t.get("type")
    ) or "(none available)"
    field_lines = "\n".join(
        f'- {f.get("field")} ({f.get("label")}, {f.get("kind")})'
        for f in fields if isinstance(f, dict) and f.get("field")
    ) or "(none available)"
    operator_line = ", ".join(str(op) for op in operators) or "(none available)"
    action_lines = "\n".join(
        f'- {a.get("action")} ({a.get("label")})'
        for a in actions if isinstance(a, dict) and a.get("action")
    ) or "(none available)"

    return (
        "Valid trigger types (use the exact string before the parentheses):\n"
        f"{trigger_lines}\n\n"
        "Valid condition fields (use the exact string before the parentheses):\n"
        f"{field_lines}\n\n"
        f"Valid condition operators: {operator_line}\n\n"
        "Valid actions (use the exact string before the parentheses):\n"
        f"{action_lines}"
    )


async def _call_llm(description: str, registry: dict[str, Any]) -> WorkflowNLDraft:
    """Isolated so tests can mock exactly this seam without touching call_agent's
    full retry/circuit-breaker machinery directly.

    `registry` is the SAME caller-supplied registry `parse_workflow_nl` validates
    the draft against post-hoc (`_registry_lookup`) — it is rendered into the
    `user` message here so the model actually sees the catalog `_SYSTEM_PROMPT`
    already claims it will be given, instead of guessing plausible-sounding
    identifiers from its own training data.
    """
    catalog = _format_catalog(registry)
    parsed, _entry = await call_agent(
        agent_name="crystal",
        system=_SYSTEM_PROMPT,
        user=f"Workflow description: {description}\n\n{catalog}",
        output_schema=WorkflowNLDraft,
    )
    return parsed


def _draft_to_engine_graph(
    draft: WorkflowNLDraft,
    valid_triggers: set[str],
    valid_fields: set[str],
    valid_actions: set[str],
    surveys_by_name: dict[str, str] | None = None,
    tags_by_name: dict[str, str] | None = None,
) -> tuple[dict, list[dict], list[dict], float, list[str], dict[str, str | None]]:
    """Validate `draft` against the registry sets and build engine nodes/edges.

    Returns (result_meta, nodes, edges, confidence, warnings, scope). `result_meta`
    is {"name":..., "description":...}. `scope` is
    {"scope_type": ..., "scope_survey_id": ..., "scope_tag_id": ...}. Confidence
    is `draft.confidence` reduced by `_REGISTRY_DRIFT_PENALTY` per dropped
    trigger/action/unmatched-scope-hint (multiplicative).

    `surveys_by_name`/`tags_by_name` default to empty dicts (not None) so a
    caller that never passes them (e.g. any future direct call site) gets
    today's exact behavior — `scope_hint` (if present) simply never matches,
    falling back to org scope, same as always.
    """
    warnings = list(draft.warnings)
    confidence = draft.confidence
    drift_hits = 0

    nodes: list[dict] = []
    edges: list[dict] = []

    trigger_type = draft.trigger.trigger_type
    if trigger_type not in valid_triggers:
        drift_hits += 1
        warnings.append(
            f'"{trigger_type}" is not a recognized trigger — this workflow could not be built.'
        )
        trigger_type = None

    trigger_id = "trigger-1"
    if trigger_type:
        nodes.append({"id": trigger_id, "type": "trigger", "trigger": trigger_type})

    prev_id = trigger_id if trigger_type else None

    # Conditions — drop individual rules whose field isn't in the registry
    # (keep the rest; a partially-valid condition set is still useful) but
    # flag drift. Operators are less strictly policed (registry's operator
    # list is universal, not per-field) — still checked for safety.
    valid_rules = []
    for cond in draft.conditions:
        if cond.field not in valid_fields:
            drift_hits += 1
            warnings.append(f'"{cond.field}" is not a recognized condition field and was dropped.')
            continue
        valid_rules.append({"field": cond.field, "op": cond.op, "value": _coerce_value(cond.value)})

    if valid_rules and prev_id:
        cond_id = "condition-1"
        nodes.append({
            "id": cond_id,
            "type": "condition",
            "conditions": {"operator": "AND", "rules": valid_rules},
        })
        edges.append({"from": prev_id, "to": cond_id})
        prev_id = cond_id

    action_count = 0
    for i, act in enumerate(draft.actions):
        if act.action not in valid_actions:
            drift_hits += 1
            warnings.append(f'"{act.action}" is not a recognized action and was dropped.')
            continue
        action_count += 1
        action_id = f"action-{action_count}"
        nodes.append({"id": action_id, "type": "action", "action": act.action, "config": act.config or {}})
        if act.assumed and act.assumption_note:
            warnings.append(act.assumption_note)
        if prev_id:
            edges.append({"from": prev_id, "to": action_id})
        # Sequential actions chain off the previous action (not the trigger/condition)
        # so multiple actions run in order — matches serializeCanvas's linear chaining.
        prev_id = action_id

    # Scope resolution (Wave 12 — BUILDER_REDESIGN_V2_SCOPE.md). Additive only:
    # no hint -> org, no warning, no confidence change (today's exact behavior).
    # A hint that resolves to nothing real is the one case that counts as
    # registry drift, same severity class as a hallucinated trigger/action.
    scope_type, scope_survey_id, scope_tag_id, scope_warning = _resolve_scope_hint(
        draft.scope_hint, surveys_by_name or {}, tags_by_name or {},
    )
    if scope_warning:
        drift_hits += 1
        warnings.append(scope_warning)

    if drift_hits:
        confidence = confidence * (1 - _REGISTRY_DRIFT_PENALTY) ** drift_hits

    # A trigger-less or action-less graph is not a usable workflow regardless
    # of what the raw confidence said.
    if trigger_type is None or action_count == 0:
        confidence = min(confidence, UNPARSEABLE_THRESHOLD - 0.01)

    meta = {"name": draft.name.strip()[:60] or "Untitled workflow", "description": draft.description.strip()}
    scope = {"scope_type": scope_type, "scope_survey_id": scope_survey_id, "scope_tag_id": scope_tag_id}
    return meta, nodes, edges, max(0.0, min(1.0, confidence)), warnings, scope


class WorkflowNLResult(BaseModel):
    """Normalized result shared by both call sites. `nodes`/`edges` are plain
    dicts matching `EngineNode`/`EngineEdge` (see workflowCanvas.ts) — kept as
    dicts rather than a Pydantic model since the engine's shape is a Node/TS
    contract, not owned here."""
    ok: bool
    name: str = ""
    description: str = ""
    trigger_type: str | None = None
    nodes: list[dict] = Field(default_factory=list)
    edges: list[dict] = Field(default_factory=list)
    confidence: float = 0.0
    warnings: list[str] = Field(default_factory=list)
    message: str = ""
    suggestions: list[str] = Field(default_factory=list)
    # Scope (Wave 12 — BUILDER_REDESIGN_V2_SCOPE.md). Defaults are IDENTICAL to
    # pre-Wave-12 implicit behavior (every NL workflow was silently org-wide).
    scope_type: str = "org"
    scope_survey_id: str | None = None
    scope_tag_id: str | None = None


def _example_suggestions(registry: dict[str, Any]) -> list[str]:
    """Build 2-3 concrete example prompts from REAL registry entries, for the
    422 unparseable response (per the task's requirement — never invent
    examples that don't map onto the live catalog)."""
    triggers = registry.get("triggers") or []
    actions = registry.get("actions") or []
    trigger_label = next((t.get("label") for t in triggers if t.get("type") == "score.nps_drop"), None) \
        or (triggers[0].get("label") if triggers else "a score drops")
    slack_label = next((a.get("label") for a in actions if a.get("action") == "notify.slack"), "send a Slack message")
    jira_label = next((a.get("label") for a in actions if a.get("action") == "jira.create_issue"), None)

    out = [
        f'"When {trigger_label.lower()}, {slack_label.lower()}"' if trigger_label and slack_label else None,
        '"When a response mentions \'refund\', create a support ticket"',
    ]
    if jira_label:
        out.append(f'"When NPS drops below 30, {slack_label.lower()} and {jira_label.lower()}"')
    return [s for s in out if s][:3]


async def parse_workflow_nl(description: str, registry: dict[str, Any]) -> WorkflowNLResult:
    """Core NL → workflow-graph conversion, shared by the HTTP endpoint and the
    legacy `propose_workflow` chat tool.

    Never raises for a bad/unparseable description or an LLM hiccup — always
    returns a `WorkflowNLResult` with `ok` reflecting whether a usable
    (>= UNPARSEABLE_THRESHOLD confidence) result was produced. Callers map
    `ok=False` to their own error shape (422 for the HTTP endpoint; a
    "couldn't build that" proposal for the chat tool).
    """
    valid_triggers, valid_fields, valid_actions = _registry_lookup(registry)
    surveys_by_name, tags_by_name = _scope_catalog_lookup(registry)

    try:
        draft = await _call_llm(description, registry)
    except (AgentOutputError, OpenRouterError, CircuitBreakerOpen) as exc:
        logger.warning("workflow_nl_parse_llm_failed", error=str(exc))
        return WorkflowNLResult(
            ok=False,
            message="Crystal couldn't turn that into a workflow — the AI service is temporarily unavailable.",
            suggestions=_example_suggestions(registry),
        )
    except Exception as exc:  # defensive — never let a parse crash the endpoint
        logger.error("workflow_nl_parse_unexpected_error", error=str(exc))
        return WorkflowNLResult(
            ok=False,
            message="Crystal couldn't turn that into a workflow.",
            suggestions=_example_suggestions(registry),
        )

    if draft.unparseable:
        return WorkflowNLResult(
            ok=False,
            message=draft.unparseable_reason or "Crystal couldn't find a trigger and action in that description.",
            suggestions=_example_suggestions(registry),
        )

    meta, nodes, edges, confidence, warnings, scope = _draft_to_engine_graph(
        draft, valid_triggers, valid_fields, valid_actions, surveys_by_name, tags_by_name,
    )

    if confidence < UNPARSEABLE_THRESHOLD:
        # Diagnostic-only (no prior log statement existed for this branch —
        # a real gap, since without it a low-confidence/registry-drift outcome
        # was completely invisible server-side, only ever surfaced to the user
        # as the generic 422 message). Logs the LLM's raw proposal alongside
        # the post-validation confidence so a "why did this fail" investigation
        # doesn't require reproducing the exact same non-deterministic LLM call.
        logger.warning(
            "workflow_nl_parse_low_confidence",
            raw_trigger_type=draft.trigger.trigger_type,
            raw_actions=[a.action for a in draft.actions],
            raw_confidence=draft.confidence,
            post_validation_confidence=confidence,
            warnings=warnings,
            scope_hint=draft.scope_hint,
        )
        return WorkflowNLResult(
            ok=False,
            message="Crystal wasn't able to match that to a valid trigger and action.",
            suggestions=_example_suggestions(registry),
        )

    trigger_node = next((n for n in nodes if n["type"] == "trigger"), None)
    return WorkflowNLResult(
        ok=True,
        name=meta["name"],
        description=meta["description"],
        trigger_type=trigger_node["trigger"] if trigger_node else None,
        nodes=nodes,
        edges=edges,
        confidence=confidence,
        warnings=warnings,
        scope_type=scope["scope_type"],
        scope_survey_id=scope["scope_survey_id"],
        scope_tag_id=scope["scope_tag_id"],
    )
