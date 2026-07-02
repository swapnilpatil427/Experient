"""Tests for crystal/workflow_nl.py — the shared NL-workflow-parsing core used
by both POST /workflows/parse-nl and the legacy propose_workflow chat tool.

Per crystalos/CLAUDE.md testing rules: mock LLM calls via AsyncMock, patch
`crystalos.lib.openrouter.call_agent` (or, here, the module's own thin
`_call_llm` wrapper around it — both are exercised). Never make real LLM calls.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from crystalos.crystal.workflow_nl import (
    parse_workflow_nl,
    WorkflowNLDraft,
    WorkflowNLTriggerDraft,
    WorkflowNLConditionDraft,
    WorkflowNLActionDraft,
    FALLBACK_REGISTRY,
    UNPARSEABLE_THRESHOLD,
    LOW_CONFIDENCE_THRESHOLD,
)

REGISTRY = {
    "triggers": [
        {"type": "score.nps_drop", "category": "Score", "label": "NPS dropped"},
        {"type": "survey.response_received", "category": "Survey", "label": "Response received"},
    ],
    "conditionFields": [
        {"field": "nps", "label": "NPS score", "kind": "number"},
    ],
    "conditionOperators": ["eq", "neq", "gt", "lt", "gte", "lte"],
    "actions": [
        {"action": "notify.slack", "category": "Notify", "label": "Slack message", "live": True},
        {"action": "jira.create_issue", "category": "Integration", "label": "Create Jira issue", "live": "env"},
    ],
}


def _draft(**overrides) -> WorkflowNLDraft:
    defaults = dict(
        name="NPS drop alert",
        description="Notify support when NPS drops below 30",
        trigger=WorkflowNLTriggerDraft(trigger_type="score.nps_drop"),
        conditions=[WorkflowNLConditionDraft(field="nps", op="lt", value="30")],
        actions=[WorkflowNLActionDraft(action="notify.slack", config={"channel": "#cx"})],
        confidence=0.9,
        warnings=[],
        unparseable=False,
        unparseable_reason=None,
    )
    defaults.update(overrides)
    return WorkflowNLDraft(**defaults)


class TestParseWorkflowNLHappyPath:
    @pytest.mark.asyncio
    async def test_valid_description_produces_engine_graph(self):
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=_draft())):
            result = await parse_workflow_nl("When NPS drops below 30, notify support on Slack", REGISTRY)

        assert result.ok is True
        assert result.trigger_type == "score.nps_drop"
        assert result.confidence == pytest.approx(0.9)
        assert len(result.nodes) == 3  # trigger, condition, action
        trigger_node = next(n for n in result.nodes if n["type"] == "trigger")
        condition_node = next(n for n in result.nodes if n["type"] == "condition")
        action_node = next(n for n in result.nodes if n["type"] == "action")
        assert trigger_node["trigger"] == "score.nps_drop"
        assert condition_node["conditions"]["rules"][0]["field"] == "nps"
        assert condition_node["conditions"]["rules"][0]["value"] == 30  # coerced to int
        assert action_node["action"] == "notify.slack"
        # edges chain trigger -> condition -> action
        assert {"from": "trigger-1", "to": "condition-1"} in result.edges
        assert {"from": "condition-1", "to": "action-1"} in result.edges

    @pytest.mark.asyncio
    async def test_no_condition_still_produces_valid_graph(self):
        draft = _draft(conditions=[])
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl("On every response, notify support", REGISTRY)
        assert result.ok is True
        assert not any(n["type"] == "condition" for n in result.nodes)
        assert {"from": "trigger-1", "to": "action-1"} in result.edges

    @pytest.mark.asyncio
    async def test_multiple_actions_chain_sequentially(self):
        draft = _draft(actions=[
            WorkflowNLActionDraft(action="notify.slack", config={}),
            WorkflowNLActionDraft(action="jira.create_issue", config={}),
        ])
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl("desc", REGISTRY)
        assert result.ok is True
        action_ids = [n["id"] for n in result.nodes if n["type"] == "action"]
        assert action_ids == ["action-1", "action-2"]
        assert {"from": "action-1", "to": "action-2"} in result.edges

    @pytest.mark.asyncio
    async def test_assumed_action_adds_warning(self):
        draft = _draft(actions=[
            WorkflowNLActionDraft(action="notify.slack", config={"channel": "#cx"}, assumed=True,
                                   assumption_note="Assumed Slack channel #cx (not specified)"),
        ])
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl("desc", REGISTRY)
        assert "Assumed Slack channel #cx (not specified)" in result.warnings


class TestRegistryValidation:
    """A hallucinated trigger/action/field must be dropped and confidence lowered — never returned."""

    @pytest.mark.asyncio
    async def test_hallucinated_trigger_is_dropped_and_lowers_confidence(self):
        draft = _draft(trigger=WorkflowNLTriggerDraft(trigger_type="made.up.trigger"), confidence=0.95)
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl("desc", REGISTRY)
        # No trigger survived registry validation -> confidence forced below unparseable threshold -> ok=False
        assert result.ok is False
        assert "made.up.trigger" not in str(result.nodes)

    @pytest.mark.asyncio
    async def test_hallucinated_action_dropped_but_valid_ones_kept(self):
        draft = _draft(actions=[
            WorkflowNLActionDraft(action="notify.slack", config={}),
            WorkflowNLActionDraft(action="made.up.action", config={}),
        ], confidence=0.95)
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl("desc", REGISTRY)
        assert result.ok is True
        action_types = [n["action"] for n in result.nodes if n["type"] == "action"]
        assert action_types == ["notify.slack"]
        assert any("made.up.action" in w for w in result.warnings)
        # confidence must be reduced from the raw 0.95 due to the drift penalty
        assert result.confidence < 0.95

    @pytest.mark.asyncio
    async def test_hallucinated_condition_field_dropped_condition_omitted_if_empty(self):
        draft = _draft(conditions=[WorkflowNLConditionDraft(field="made_up_field", op="lt", value="1")])
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl("desc", REGISTRY)
        assert result.ok is True
        assert not any(n["type"] == "condition" for n in result.nodes)
        assert any("made_up_field" in w for w in result.warnings)

    @pytest.mark.asyncio
    async def test_all_actions_hallucinated_is_unparseable(self):
        draft = _draft(actions=[WorkflowNLActionDraft(action="totally.fake", config={})], confidence=0.9)
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl("desc", REGISTRY)
        assert result.ok is False


class TestUnparseablePath:
    @pytest.mark.asyncio
    async def test_llm_flags_unparseable(self):
        draft = _draft(unparseable=True, unparseable_reason="This isn't a workflow request.")
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl("What's the weather like?", REGISTRY)
        assert result.ok is False
        assert result.message == "This isn't a workflow request."
        assert len(result.suggestions) >= 1
        assert len(result.suggestions) <= 3

    @pytest.mark.asyncio
    async def test_llm_failure_returns_unparseable_with_suggestions(self):
        from crystalos.lib.openrouter import AgentOutputError
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(side_effect=AgentOutputError("boom"))):
            result = await parse_workflow_nl("desc", REGISTRY)
        assert result.ok is False
        assert result.suggestions

    @pytest.mark.asyncio
    async def test_unexpected_exception_never_raises(self):
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(side_effect=RuntimeError("weird"))):
            result = await parse_workflow_nl("desc", REGISTRY)
        assert result.ok is False


class TestConfidenceThresholds:
    def test_thresholds_are_ordered(self):
        assert 0 < UNPARSEABLE_THRESHOLD < LOW_CONFIDENCE_THRESHOLD < 1

    @pytest.mark.asyncio
    async def test_low_confidence_still_returns_ok_true(self):
        """Below the UI's confirm-card threshold but above the unparseable floor
        still returns ok=True — the 0.6 split is a frontend rendering decision,
        not a backend reject (see BUILDER_SPEC_WAVE2.md §2.4b)."""
        draft = _draft(confidence=0.4)
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl("desc", REGISTRY)
        assert result.ok is True
        assert result.confidence == pytest.approx(0.4)


class TestFallbackRegistry:
    def test_fallback_registry_has_required_shape(self):
        assert "triggers" in FALLBACK_REGISTRY
        assert "actions" in FALLBACK_REGISTRY
        assert "conditionFields" in FALLBACK_REGISTRY
        assert any(t["type"] == "score.nps_drop" for t in FALLBACK_REGISTRY["triggers"])

    @pytest.mark.asyncio
    async def test_fallback_registry_validates_a_real_parse(self):
        draft = _draft()
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl("desc", FALLBACK_REGISTRY)
        assert result.ok is True
