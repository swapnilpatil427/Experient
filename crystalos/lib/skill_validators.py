"""Deterministic per-skill EVALS.md criterion validators.

Keyed by (skill_name, criterion_id) so a skill's own must-pass criteria can be
graded by exact Python logic instead of the generic LLM judge, without
touching the generic structural/LLM dispatch other skills still use.

Field names below are verified against the real schemas in each skill's own
SKILL.md/EVALS.md (`crystalos/skills/compliance-scanner/`,
`crystalos/skills/workflow-analyst/`) — not the illustrative sketch this file
started from.
"""
from __future__ import annotations

import re
from typing import Callable

_GDPR_CITATION_PATTERN = re.compile(r"GDPR\s+Art\.?\s?\d+", re.IGNORECASE)
_CCPA_CITATION_PATTERN = re.compile(r"CCPA\s+(§|Section)\s?\d+", re.IGNORECASE)


def validate_compliance_citation(input_data: dict, output: dict) -> float:
    """compliance-scanner E5: "GDPR issues include regulation_reference".

    Real output schema (`compliance-scanner/SKILL.md`): `issues[]` entries have
    `category` (one of `gdpr | ccpa | bias | accessibility | sensitive_topic`)
    and `regulation_reference` (string | null, e.g. "GDPR Art. 9 — Special
    Categories" per the skill's own Quality Standards). A gdpr/ccpa-categorized
    issue must cite a real-looking regulation reference rather than a vague or
    absent one.
    """
    issues = output.get("issues", [])
    if not isinstance(issues, list):
        return 0.0
    for issue in issues:
        if not isinstance(issue, dict):
            continue
        category = str(issue.get("category", "")).lower()
        ref = str(issue.get("regulation_reference") or "")
        if category == "gdpr" and not _GDPR_CITATION_PATTERN.search(ref):
            return 0.0
        if category == "ccpa" and not _CCPA_CITATION_PATTERN.search(ref):
            return 0.0
    return 1.0


def _wf_creates(output: dict) -> list[dict]:
    """Every `create_workflow` proposal in a workflow-analyst turn.

    Real output schema (`workflow-analyst/SKILL.md`): the proposals array is
    `action_proposals[]` (this skill emits no `actions` field at all — that
    name belongs to the *-action-advisor skills' unrelated output schema).
    """
    proposals = output.get("action_proposals") or []
    if not isinstance(proposals, list):
        return []
    return [p for p in proposals if isinstance(p, dict) and p.get("type") == "create_workflow"]


def validate_workflow_registry_grounding(input_data: dict, output: dict) -> float:
    """workflow-analyst E2: every create_workflow proposal's trigger_type/
    condition field/action must exist in the workflow registry.

    The registry arrives via `input_data["survey_facts"]["workflow_registry"]`
    (confirmed via workflow-analyst/SKILL.md's Input Schema and compatibility
    note) — NEVER via `tool_results`: no tool in TOOL_REGISTRY returns it, it's
    injected as page/context data (Wave 15 builder-context injection), not
    fetched by a tool call.

    Registry shape: `triggers: [{type, category, label}]`,
    `conditionFields: [{field, label, kind}]`,
    `actions: [{action, category, label, live}]`.

    Proposal shape: `params.trigger_type` (string), `params.nodes` (list of
    `{id, type: trigger|condition|action, trigger?, conditions?, action?}`).
    """
    creates = _wf_creates(output)
    if not creates:
        return 1.0  # vacuous pass — nothing to ground

    registry = (input_data.get("survey_facts") or {}).get("workflow_registry")
    if not registry:
        # A create_workflow proposal with no registry available is ungrounded
        # by construction (workflow-analyst's own Core Principle 1 forbids
        # naming an unverifiable trigger/field/action) — correct fail, not a
        # bug.
        return 0.0

    triggers = {t.get("type") for t in registry.get("triggers", []) if isinstance(t, dict)}
    fields = {f.get("field") for f in registry.get("conditionFields", []) if isinstance(f, dict)}
    actions = {a.get("action") for a in registry.get("actions", []) if isinstance(a, dict)}

    for p in creates:
        params = p.get("params") or {}
        if params.get("trigger_type") not in (None, *triggers):
            return 0.0
        for node in params.get("nodes") or []:
            if not isinstance(node, dict):
                continue
            ntype = node.get("type")
            if ntype == "trigger" and node.get("trigger") not in (None, *triggers):
                return 0.0
            if ntype == "condition":
                conditions = node.get("conditions")
                if conditions is not None and not isinstance(conditions, dict):
                    # Malformed shape (e.g. a string/list instead of the
                    # expected {operator, rules} object) is itself a
                    # grounding failure, not something to silently skip.
                    return 0.0
                for rule in (conditions or {}).get("rules") or []:
                    if isinstance(rule, dict) and rule.get("field") not in fields:
                        return 0.0
            if ntype == "action" and node.get("action") not in (None, *actions):
                return 0.0
    return 1.0


def validate_requires_confirmation(input_data: dict, output: dict) -> float:
    """workflow-analyst E3: every create_workflow proposal must have
    requires_confirmation is True."""
    for p in _wf_creates(output):
        if p.get("requires_confirmation") is not True:
            return 0.0
    return 1.0


def validate_single_workflow_proposal(input_data: dict, output: dict) -> float:
    """workflow-analyst E6: at most one create_workflow proposal per turn."""
    return 1.0 if len(_wf_creates(output)) <= 1 else 0.0


SKILL_CRITERION_VALIDATORS: dict[tuple[str, str], Callable[[dict, dict], float]] = {
    ("compliance-scanner", "E5"): validate_compliance_citation,
    ("workflow-analyst", "E2"): validate_workflow_registry_grounding,
    ("workflow-analyst", "E3"): validate_requires_confirmation,
    ("workflow-analyst", "E6"): validate_single_workflow_proposal,
}
