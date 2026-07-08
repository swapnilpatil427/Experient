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
    _call_llm,
    _format_catalog,
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

# Registry variant carrying the Wave 12 scope catalog (surveys/tags), for the
# new scope-resolution tests. Kept separate from REGISTRY (used by every
# pre-existing test) so those tests continue to exercise the "no surveys/tags
# key at all" path unmodified.
REGISTRY_WITH_SCOPE = {
    **REGISTRY,
    "surveys": [
        {"id": "survey-onboarding-1", "name": "Onboarding Survey"},
        {"id": "survey-nps-1", "name": "Quarterly NPS Survey"},
    ],
    "tags": [
        {"id": "tag-vip-1", "name": "VIP"},
        {"id": "tag-churn-risk-1", "name": "Churn Risk"},
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


class TestScopeResolution:
    """Wave 12 (BUILDER_REDESIGN_V2_SCOPE.md) — NL-created workflows must carry
    scope (org/survey/tag), previously silently forced to org-wide. Scope
    inference is strictly additive; the hard invariant is that a description
    with no survey/tag mention behaves byte-identically to pre-Wave-12."""

    @pytest.mark.asyncio
    async def test_no_scope_hint_defaults_to_org_byte_identical_to_before(self):
        """THE most important test in this suite: no `scope_hint` at all (the
        LLM found nothing to name) must produce exactly today's behavior —
        scope_type='org', both ids None, NO warning, NO confidence penalty."""
        draft = _draft(scope_hint=None, confidence=0.9)
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl(
                "When NPS drops below 30, notify support on Slack", REGISTRY_WITH_SCOPE,
            )
        assert result.ok is True
        assert result.scope_type == "org"
        assert result.scope_survey_id is None
        assert result.scope_tag_id is None
        assert result.confidence == pytest.approx(0.9)  # unchanged — no drift penalty
        assert result.warnings == []

    @pytest.mark.asyncio
    async def test_no_scope_hint_defaults_to_org_even_without_scope_catalog(self):
        """Registry with no `surveys`/`tags` keys at all (older caller / legacy
        FALLBACK_REGISTRY shape) must not crash and must still default to org."""
        draft = _draft(scope_hint=None)
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl("desc", REGISTRY)  # REGISTRY has no surveys/tags
        assert result.ok is True
        assert result.scope_type == "org"
        assert result.scope_survey_id is None
        assert result.scope_tag_id is None

    @pytest.mark.asyncio
    async def test_real_survey_name_resolves_to_survey_scope(self):
        draft = _draft(scope_hint="Onboarding Survey")
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl(
                "When NPS drops below 30 for the Onboarding Survey, notify support on Slack",
                REGISTRY_WITH_SCOPE,
            )
        assert result.ok is True
        assert result.scope_type == "survey"
        assert result.scope_survey_id == "survey-onboarding-1"
        assert result.scope_tag_id is None
        assert result.warnings == []
        assert result.confidence == pytest.approx(0.9)  # a real match is not drift

    @pytest.mark.asyncio
    async def test_real_survey_name_matches_case_insensitively(self):
        draft = _draft(scope_hint="onboarding survey")
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl("desc", REGISTRY_WITH_SCOPE)
        assert result.scope_type == "survey"
        assert result.scope_survey_id == "survey-onboarding-1"

    @pytest.mark.asyncio
    async def test_real_tag_name_resolves_to_tag_scope(self):
        draft = _draft(scope_hint="VIP")
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl(
                "When a VIP-tagged response scores low, notify support on Slack",
                REGISTRY_WITH_SCOPE,
            )
        assert result.ok is True
        assert result.scope_type == "tag"
        assert result.scope_tag_id == "tag-vip-1"
        assert result.scope_survey_id is None
        assert result.warnings == []

    @pytest.mark.asyncio
    async def test_unmatched_scope_hint_falls_back_to_org_with_warning_and_lower_confidence(self):
        """A hint that sounds plausible but matches nothing real must NEVER
        guess an id — same drift-penalty treatment as a hallucinated
        trigger/action, per the task's hard requirement."""
        draft = _draft(scope_hint="Made Up Survey That Does Not Exist", confidence=0.9)
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl("desc", REGISTRY_WITH_SCOPE)
        assert result.ok is True
        assert result.scope_type == "org"
        assert result.scope_survey_id is None
        assert result.scope_tag_id is None
        assert any("Made Up Survey That Does Not Exist" in w for w in result.warnings)
        assert result.confidence < 0.9  # registry-drift penalty applied

    @pytest.mark.asyncio
    async def test_ambiguous_hint_matching_both_survey_and_tag_falls_back_to_org(self):
        """If a hint could plausibly match more than one real thing (here: a
        contrived case where the same name exists as both a survey and a tag),
        conservatism wins — no guess, fall back to org with a drift warning."""
        registry = {
            **REGISTRY,
            "surveys": [{"id": "survey-x", "name": "Renewal"}],
            "tags": [{"id": "tag-x", "name": "Renewal"}],
        }
        draft = _draft(scope_hint="Renewal", confidence=0.9)
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl("desc", registry)
        assert result.scope_type == "org"
        assert result.scope_survey_id is None
        assert result.scope_tag_id is None
        assert result.confidence < 0.9

    @pytest.mark.asyncio
    async def test_substring_match_is_conservative_multiple_candidates_no_match(self):
        """Two surveys both contain the hinted word — genuinely ambiguous, must
        under-match to org rather than pick one arbitrarily."""
        registry = {
            **REGISTRY,
            "surveys": [
                {"id": "survey-a", "name": "Customer Onboarding Survey"},
                {"id": "survey-b", "name": "Partner Onboarding Survey"},
            ],
            "tags": [],
        }
        draft = _draft(scope_hint="Onboarding", confidence=0.9)
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl("desc", registry)
        assert result.scope_type == "org"
        assert result.scope_survey_id is None

    @pytest.mark.asyncio
    async def test_scope_resolution_never_crashes_on_malformed_catalog_entries(self):
        """Registry entries missing id/name (or non-dict junk) must be skipped,
        not raise."""
        registry = {
            **REGISTRY,
            "surveys": [{"name": "No Id Survey"}, {"id": "s1"}, "not-a-dict", None],
            "tags": [{"id": "t1", "name": "Ok Tag"}],
        }
        draft = _draft(scope_hint="Ok Tag")
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl("desc", registry)
        assert result.ok is True
        assert result.scope_type == "tag"
        assert result.scope_tag_id == "t1"


# Registry variant mirroring the actual production catalog entries implicated
# in the "Every Monday at 9am, email the team a summary of last week's
# responses" failure (real production log): trigger `time.schedule` and action
# `notify.email` are genuine `workflowRegistry.ts` entries the LLM guessed
# wrong ("schedule" / "email_report") because the catalog was never shown to
# it. Used by both the prompt-content test and the regression test below.
SCHEDULE_REGISTRY = {
    "triggers": [
        {"type": "time.schedule", "category": "Time", "label": "On a schedule (cron)"},
        {"type": "score.nps_drop", "category": "Score", "label": "NPS dropped"},
    ],
    "conditionFields": [
        {"field": "nps", "label": "NPS score", "kind": "number"},
    ],
    "conditionOperators": ["eq", "neq", "gt", "lt", "gte", "lte"],
    "actions": [
        {"action": "notify.email", "category": "Notify", "label": "Email", "live": True},
        {"action": "notify.slack", "category": "Notify", "label": "Slack message", "live": True},
    ],
}


class TestCatalogReachesTheModel:
    """The bug: `_SYSTEM_PROMPT` claims the model "will be given the description
    AND the exact catalog of valid triggers, condition fields/operators, and
    actions" — but `_call_llm` never actually included that catalog anywhere,
    so the model was guessing generic training-data identifiers instead of
    this project's real registry strings. These tests mock at the `call_agent`
    boundary (not `_call_llm` itself) specifically so they exercise
    `_call_llm`'s own message-construction code, proving the fix — not just
    that the code compiles."""

    @pytest.mark.asyncio
    async def test_call_llm_message_contains_exact_registry_strings(self):
        """The `user` message actually sent to the model must contain the
        VERBATIM registry type strings `_draft_to_engine_graph` will later
        validate against — not just human-readable descriptions of them."""
        draft = _draft(
            trigger=WorkflowNLTriggerDraft(trigger_type="time.schedule"),
            actions=[WorkflowNLActionDraft(action="notify.email", config={})],
        )
        with patch(
            "crystalos.crystal.workflow_nl.call_agent",
            new=AsyncMock(return_value=(draft, object())),
        ) as mock_call_agent:
            result = await _call_llm(
                "Every Monday at 9am, email the team a summary of last week's responses",
                SCHEDULE_REGISTRY,
            )

        assert result is draft
        assert mock_call_agent.await_count == 1
        _, kwargs = mock_call_agent.call_args
        user_message = kwargs["user"]

        # Every valid trigger/action/field string the post-validation step
        # checks against must appear VERBATIM in the message sent to the model.
        assert "time.schedule" in user_message
        assert "score.nps_drop" in user_message
        assert "notify.email" in user_message
        assert "notify.slack" in user_message
        assert "nps" in user_message
        # Labels should also be present for context (compact "type (label)" format).
        assert "On a schedule (cron)" in user_message
        assert "Email" in user_message
        # The original description must still be forwarded.
        assert "Every Monday at 9am" in user_message
        # system prompt is passed through unmodified (rules unchanged by this fix)
        assert kwargs["system"]
        assert kwargs["agent_name"] == "crystal"
        assert kwargs["output_schema"] is WorkflowNLDraft

    @pytest.mark.asyncio
    async def test_call_llm_omits_registry_entries_not_supplied(self):
        """Sanity check the assertion above isn't vacuously true: an action NOT
        present in the supplied registry must NOT appear in the message."""
        draft = _draft()
        with patch(
            "crystalos.crystal.workflow_nl.call_agent",
            new=AsyncMock(return_value=(draft, object())),
        ) as mock_call_agent:
            await _call_llm("desc", REGISTRY)
        _, kwargs = mock_call_agent.call_args
        assert "time.schedule" not in kwargs["user"]
        assert "notify.email" not in kwargs["user"]

    def test_format_catalog_handles_empty_registry_without_crashing(self):
        """A malformed/empty registry must degrade gracefully, not crash the
        prompt-construction step."""
        out = _format_catalog({})
        assert "(none available)" in out


class TestScheduleEmailRegressionFromProductionLog:
    """Regression test for the exact production failure: 'Every Monday at 9am,
    email the team a summary of last week's responses' produced a degraded
    draft (trigger 'schedule' instead of 'time.schedule', action
    'email_report' instead of 'notify.email', plus two invented condition
    fields that don't exist in this system at all) with confidence 0.14 —
    below UNPARSEABLE_THRESHOLD (0.25).

    This fix is entirely on the "give the model better material" side
    (`_call_llm` now actually includes the catalog) — the validation/
    confidence-penalty side (`_draft_to_engine_graph`) was already correct,
    which is WHY this bug was caught instead of silently shipping a broken
    workflow. This test proves that side keeps working by feeding it exactly
    the degraded draft from the real log, without any LLM involved."""

    @pytest.mark.asyncio
    async def test_degraded_schedule_draft_from_production_log_is_rejected(self):
        degraded_draft = WorkflowNLDraft(
            name="Weekly summary email",
            description="Email the team a summary of last week's responses every Monday at 9am",
            trigger=WorkflowNLTriggerDraft(trigger_type="schedule"),  # hallucinated; real: time.schedule
            conditions=[
                WorkflowNLConditionDraft(field="day_of_week", op="eq", value="monday"),  # invented field
                WorkflowNLConditionDraft(field="time_of_day", op="eq", value="09:00"),   # invented field
            ],
            actions=[WorkflowNLActionDraft(action="email_report", config={})],  # hallucinated; real: notify.email
            confidence=0.14,
            warnings=[],
            unparseable=False,
            unparseable_reason=None,
        )
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=degraded_draft)):
            result = await parse_workflow_nl(
                "Every Monday at 9am, email the team a summary of last week's responses",
                SCHEDULE_REGISTRY,
            )

        # Hallucinated trigger/action/fields all dropped by registry validation,
        # and the raw 0.14 confidence (already below threshold) is driven even
        # lower by the drift penalty -> hard failure, exactly as production saw.
        assert result.ok is False
        assert result.confidence == 0.0 or result.confidence < UNPARSEABLE_THRESHOLD
        assert "schedule" not in str(result.nodes)
        assert "email_report" not in str(result.nodes)
