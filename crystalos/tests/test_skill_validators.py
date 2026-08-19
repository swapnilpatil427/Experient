"""Tests for lib/skill_validators.py — deterministic per-skill EVALS.md
criterion validators (Kind B extension point).

No LLM/DB needed — these are pure functions over (input_data, output) dicts.
"""
from __future__ import annotations

from crystalos.lib.skill_validators import (
    SKILL_CRITERION_VALIDATORS,
    validate_compliance_citation,
    validate_requires_confirmation,
    validate_single_workflow_proposal,
    validate_workflow_registry_grounding,
)


# ── validate_compliance_citation (compliance-scanner E5) ──────────────────────

def test_compliance_citation_gdpr_valid_reference_passes():
    output = {
        "issues": [
            {
                "question_id": "q1",
                "category": "gdpr",
                "severity": "major",
                "description": "collects health data without opt-in",
                "regulation_reference": "GDPR Art. 9 — Special Categories",
                "recommendation": "add explicit opt-in notice",
            }
        ]
    }
    assert validate_compliance_citation({}, output) == 1.0


def test_compliance_citation_gdpr_missing_reference_fails():
    output = {
        "issues": [
            {
                "question_id": "q1",
                "category": "gdpr",
                "severity": "major",
                "description": "collects health data without opt-in",
                "regulation_reference": None,
                "recommendation": "add explicit opt-in notice",
            }
        ]
    }
    assert validate_compliance_citation({}, output) == 0.0


def test_compliance_citation_gdpr_vague_reference_fails():
    output = {
        "issues": [
            {
                "category": "gdpr",
                "regulation_reference": "GDPR compliance issue",
            }
        ]
    }
    assert validate_compliance_citation({}, output) == 0.0


def test_compliance_citation_ccpa_valid_reference_passes():
    output = {
        "issues": [
            {
                "category": "ccpa",
                "regulation_reference": "CCPA Section 1798.100",
            }
        ]
    }
    assert validate_compliance_citation({}, output) == 1.0


def test_compliance_citation_ccpa_missing_reference_fails():
    output = {"issues": [{"category": "ccpa", "regulation_reference": ""}]}
    assert validate_compliance_citation({}, output) == 0.0


def test_compliance_citation_non_gdpr_ccpa_issue_ignored():
    """A bias/accessibility issue needs no regulation_reference at all."""
    output = {
        "issues": [
            {"category": "bias", "regulation_reference": None},
            {"category": "accessibility", "regulation_reference": None},
        ]
    }
    assert validate_compliance_citation({}, output) == 1.0


def test_compliance_citation_no_issues_vacuous_pass():
    assert validate_compliance_citation({}, {"issues": []}) == 1.0


def test_compliance_citation_malformed_issues_field_fails():
    assert validate_compliance_citation({}, {"issues": "not-a-list"}) == 0.0


def test_compliance_citation_skips_non_dict_entries():
    output = {"issues": ["not-a-dict", {"category": "gdpr", "regulation_reference": "GDPR Art. 5"}]}
    assert validate_compliance_citation({}, output) == 1.0


# ── workflow-analyst validators shared fixtures ────────────────────────────────

_REGISTRY = {
    "triggers": [{"type": "score.nps_drop", "category": "Score", "label": "NPS dropped"}],
    "conditionFields": [{"field": "nps", "label": "NPS score", "kind": "number"}],
    "conditionOperators": ["lt"],
    "actions": [{"action": "notify.slack", "category": "Notify", "label": "Slack message", "live": True}],
}


def _make_proposal(trigger_type="score.nps_drop", field="nps", action="notify.slack", requires_confirmation=True):
    return {
        "type": "create_workflow",
        "title": "Alert on NPS drop",
        "description": "NPS dropped below threshold",
        "params": {
            "trigger_type": trigger_type,
            "nodes": [
                {"id": "trigger-1", "type": "trigger", "trigger": trigger_type},
                {
                    "id": "condition-1",
                    "type": "condition",
                    "conditions": {"operator": "AND", "rules": [{"field": field, "op": "lt", "value": 30}]},
                },
                {"id": "action-1", "type": "action", "action": action, "config": {}},
            ],
            "edges": [{"from": "trigger-1", "to": "condition-1"}, {"from": "condition-1", "to": "action-1"}],
            "confidence": 0.9,
            "warnings": [],
        },
        "priority": "high",
        "requires_confirmation": requires_confirmation,
    }


# ── validate_workflow_registry_grounding (workflow-analyst E2) ────────────────

def test_workflow_grounding_zero_proposals_vacuous_pass():
    input_data = {"survey_facts": {"workflow_registry": _REGISTRY}}
    assert validate_workflow_registry_grounding(input_data, {"action_proposals": []}) == 1.0


def test_workflow_grounding_registry_absent_but_proposal_present_fails():
    """A create_workflow proposal with no registry available is ungrounded by
    construction — must fail, not vacuously pass."""
    output = {"action_proposals": [_make_proposal()]}
    assert validate_workflow_registry_grounding({}, output) == 0.0
    assert validate_workflow_registry_grounding({"survey_facts": {}}, output) == 0.0


def test_workflow_grounding_registry_present_valid_trigger_passes():
    input_data = {"survey_facts": {"workflow_registry": _REGISTRY}}
    output = {"action_proposals": [_make_proposal()]}
    assert validate_workflow_registry_grounding(input_data, output) == 1.0


def test_workflow_grounding_registry_present_invalid_trigger_fails():
    input_data = {"survey_facts": {"workflow_registry": _REGISTRY}}
    output = {"action_proposals": [_make_proposal(trigger_type="survey.abandoned")]}
    assert validate_workflow_registry_grounding(input_data, output) == 0.0


def test_workflow_grounding_registry_present_invalid_condition_field_fails():
    input_data = {"survey_facts": {"workflow_registry": _REGISTRY}}
    output = {"action_proposals": [_make_proposal(field="not_a_real_field")]}
    assert validate_workflow_registry_grounding(input_data, output) == 0.0


def test_workflow_grounding_registry_present_invalid_action_fails():
    input_data = {"survey_facts": {"workflow_registry": _REGISTRY}}
    output = {"action_proposals": [_make_proposal(action="notify.slack_channel")]}
    assert validate_workflow_registry_grounding(input_data, output) == 0.0


def test_workflow_grounding_malformed_conditions_shape_fails_not_raises():
    """A condition node whose `conditions` field is a non-dict (a real shape
    mismatch this validator exists to catch, not a hypothetical) must fail
    the criterion cleanly rather than raise — an unhandled AttributeError
    here would propagate up through _skill_synthesis's broad except and
    silently discard the entire skill run instead of just this criterion."""
    input_data = {"survey_facts": {"workflow_registry": _REGISTRY}}
    proposal = _make_proposal()
    proposal["params"]["nodes"][1]["conditions"] = "not-a-dict"
    output = {"action_proposals": [proposal]}
    assert validate_workflow_registry_grounding(input_data, output) == 0.0


def test_workflow_grounding_ignores_non_create_workflow_proposals():
    input_data = {"survey_facts": {"workflow_registry": _REGISTRY}}
    output = {"action_proposals": [{"type": "create_alert", "params": {"trigger_type": "bogus"}}]}
    assert validate_workflow_registry_grounding(input_data, output) == 1.0


def test_workflow_grounding_trigger_type_none_is_vacuously_allowed():
    """Matches the plan's illustrative design: an absent trigger_type doesn't
    itself trigger a grounding failure (other criteria — e.g. schema
    completeness — would catch that separately)."""
    input_data = {"survey_facts": {"workflow_registry": _REGISTRY}}
    proposal = _make_proposal()
    proposal["params"]["trigger_type"] = None
    output = {"action_proposals": [proposal]}
    assert validate_workflow_registry_grounding(input_data, output) == 1.0


# ── validate_requires_confirmation (workflow-analyst E3) ──────────────────────

def test_requires_confirmation_true_passes():
    output = {"action_proposals": [_make_proposal(requires_confirmation=True)]}
    assert validate_requires_confirmation({}, output) == 1.0


def test_requires_confirmation_false_fails():
    output = {"action_proposals": [_make_proposal(requires_confirmation=False)]}
    assert validate_requires_confirmation({}, output) == 0.0


def test_requires_confirmation_missing_fails():
    proposal = _make_proposal()
    del proposal["requires_confirmation"]
    output = {"action_proposals": [proposal]}
    assert validate_requires_confirmation({}, output) == 0.0


def test_requires_confirmation_zero_proposals_vacuous_pass():
    assert validate_requires_confirmation({}, {"action_proposals": []}) == 1.0


# ── validate_single_workflow_proposal (workflow-analyst E6) ───────────────────

def test_single_workflow_proposal_zero_passes():
    assert validate_single_workflow_proposal({}, {"action_proposals": []}) == 1.0


def test_single_workflow_proposal_one_passes():
    output = {"action_proposals": [_make_proposal()]}
    assert validate_single_workflow_proposal({}, output) == 1.0


def test_single_workflow_proposal_two_fails():
    output = {"action_proposals": [_make_proposal(), _make_proposal(trigger_type="score.csat_drop")]}
    assert validate_single_workflow_proposal({}, output) == 0.0


# ── registry wiring ────────────────────────────────────────────────────────────

def test_skill_criterion_validators_registry_has_exactly_the_four_pilots():
    assert set(SKILL_CRITERION_VALIDATORS.keys()) == {
        ("compliance-scanner", "E5"),
        ("workflow-analyst", "E2"),
        ("workflow-analyst", "E3"),
        ("workflow-analyst", "E6"),
    }
