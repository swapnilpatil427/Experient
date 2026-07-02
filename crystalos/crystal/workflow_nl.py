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
  "unparseable_reason": null
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
and still fill `trigger`/`actions` with your best guess (they will be ignored)."""


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


async def _call_llm(description: str) -> WorkflowNLDraft:
    """Isolated so tests can mock exactly this seam without touching call_agent's
    full retry/circuit-breaker machinery directly."""
    parsed, _entry = await call_agent(
        agent_name="crystal",
        system=_SYSTEM_PROMPT,
        user=f"Workflow description: {description}",
        output_schema=WorkflowNLDraft,
    )
    return parsed


def _draft_to_engine_graph(
    draft: WorkflowNLDraft,
    valid_triggers: set[str],
    valid_fields: set[str],
    valid_actions: set[str],
) -> tuple[dict, list[dict], list[dict], float, list[str]]:
    """Validate `draft` against the registry sets and build engine nodes/edges.

    Returns (result_meta, nodes, edges, confidence, warnings). `result_meta` is
    {"name":..., "description":...}. Confidence is `draft.confidence` reduced by
    `_REGISTRY_DRIFT_PENALTY` per dropped trigger/action (multiplicative).
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

    if drift_hits:
        confidence = confidence * (1 - _REGISTRY_DRIFT_PENALTY) ** drift_hits

    # A trigger-less or action-less graph is not a usable workflow regardless
    # of what the raw confidence said.
    if trigger_type is None or action_count == 0:
        confidence = min(confidence, UNPARSEABLE_THRESHOLD - 0.01)

    meta = {"name": draft.name.strip()[:60] or "Untitled workflow", "description": draft.description.strip()}
    return meta, nodes, edges, max(0.0, min(1.0, confidence)), warnings


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

    try:
        draft = await _call_llm(description)
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

    meta, nodes, edges, confidence, warnings = _draft_to_engine_graph(
        draft, valid_triggers, valid_fields, valid_actions,
    )

    if confidence < UNPARSEABLE_THRESHOLD:
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
    )
