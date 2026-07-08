"""Tests for POST /workflows/parse-nl (crystalos/main.py).

Calls the handler function directly (not via HTTP/TestClient) with a fake
Request, mirroring tests/test_crud_endpoints.py's existing pattern for
main.py endpoints — avoids spinning up the app lifespan (DB pool, LangGraph
build). The LLM call is mocked at `crystal.workflow_nl._call_llm` per the
testing rules (AsyncMock, never a real call).
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from crystalos.crystal.workflow_nl import (
    WorkflowNLDraft, WorkflowNLTriggerDraft, WorkflowNLConditionDraft, WorkflowNLActionDraft,
)

REGISTRY = {
    "triggers": [{"type": "score.nps_drop", "category": "Score", "label": "NPS dropped"}],
    "conditionFields": [{"field": "nps", "label": "NPS score", "kind": "number"}],
    "conditionOperators": ["lt", "gt"],
    "actions": [{"action": "notify.slack", "category": "Notify", "label": "Slack message", "live": True}],
}

# Wave 12 (BUILDER_REDESIGN_V2_SCOPE.md) — registry variant carrying the scope
# catalog Nina's Node proxy forwards. Kept separate from REGISTRY so all
# pre-existing tests keep exercising the "no surveys/tags key" path unmodified.
REGISTRY_WITH_SCOPE = {
    **REGISTRY,
    "surveys": [{"id": "survey-onboarding-1", "name": "Onboarding Survey"}],
    "tags": [{"id": "tag-vip-1", "name": "VIP"}],
}


class _FakeRequest:
    def __init__(self, body: dict):
        self._body = body

    async def json(self):
        return self._body


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


@pytest.mark.asyncio
class TestParseWorkflowNLEndpoint:
    async def test_valid_request_returns_camelcase_200_body(self):
        from crystalos.main import parse_workflow_nl_endpoint

        req = _FakeRequest({"description": "When NPS drops below 30, notify support on Slack", "org_id": "org-1", "registry": REGISTRY})
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=_draft())):
            result = await parse_workflow_nl_endpoint(req, None)

        # Must be a plain dict (not a Response object) matching the frontend's
        # ParseWorkflowNLResult shape EXACTLY, camelCase — see
        # WORKFLOW_SIGNAL_CONTRACT.md §6.1 item 3. Wave 12 adds scopeType/
        # scopeSurveyId/scopeTagId (additive — see docs/automation-hub/
        # BUILDER_REDESIGN_V2_SCOPE.md).
        assert isinstance(result, dict)
        assert set(result.keys()) == {
            "name", "description", "triggerType", "nodes", "edges", "confidence", "warnings",
            "scopeType", "scopeSurveyId", "scopeTagId",
        }
        assert result["triggerType"] == "score.nps_drop"
        assert result["confidence"] == pytest.approx(0.9)
        assert isinstance(result["nodes"], list) and isinstance(result["edges"], list)
        # No survey/tag mentioned -> org scope, IDENTICAL to pre-Wave-12 behavior.
        assert result["scopeType"] == "org"
        assert result["scopeSurveyId"] is None
        assert result["scopeTagId"] is None

    async def test_empty_description_returns_flat_422_body(self):
        from crystalos.main import parse_workflow_nl_endpoint
        from fastapi.responses import JSONResponse

        req = _FakeRequest({"description": "", "org_id": "org-1", "registry": REGISTRY})
        result = await parse_workflow_nl_endpoint(req, None)

        assert isinstance(result, JSONResponse)
        assert result.status_code == 422
        body = json.loads(result.body)
        # FLAT — no nested "detail" key. This is the exact mismatch
        # WORKFLOW_SIGNAL_CONTRACT.md §1.3.2 flagged as highest-risk.
        assert "detail" not in body
        assert body["error"] == "unparseable"
        assert "message" in body
        assert body["suggestions"] == []

    async def test_description_too_long_returns_422(self):
        from crystalos.main import parse_workflow_nl_endpoint
        from fastapi.responses import JSONResponse

        req = _FakeRequest({"description": "x" * 1001, "org_id": "org-1", "registry": REGISTRY})
        result = await parse_workflow_nl_endpoint(req, None)
        assert isinstance(result, JSONResponse)
        assert result.status_code == 422

    async def test_unparseable_llm_result_returns_flat_422_with_suggestions(self):
        from crystalos.main import parse_workflow_nl_endpoint
        from fastapi.responses import JSONResponse

        draft = _draft(unparseable=True, unparseable_reason="Not a workflow request.")
        req = _FakeRequest({"description": "hello", "org_id": "org-1", "registry": REGISTRY})
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl_endpoint(req, None)

        assert isinstance(result, JSONResponse)
        assert result.status_code == 422
        body = json.loads(result.body)
        assert "detail" not in body
        assert body["message"] == "Not a workflow request."
        assert isinstance(body["suggestions"], list)
        assert len(body["suggestions"]) >= 1

    async def test_registry_drift_lowers_confidence_but_can_still_200(self):
        from crystalos.main import parse_workflow_nl_endpoint

        draft = _draft(actions=[
            WorkflowNLActionDraft(action="notify.slack", config={}),
            WorkflowNLActionDraft(action="made.up.action", config={}),
        ], confidence=0.95)
        req = _FakeRequest({"description": "desc", "org_id": "org-1", "registry": REGISTRY})
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl_endpoint(req, None)

        assert isinstance(result, dict)
        assert result["confidence"] < 0.95
        assert any("made.up.action" in w for w in result["warnings"])

    async def test_missing_registry_defaults_to_empty_and_fails_closed(self):
        """No registry supplied -> nothing validates -> unparseable (never emits
        an unvalidated trigger/action)."""
        from crystalos.main import parse_workflow_nl_endpoint
        from fastapi.responses import JSONResponse

        req = _FakeRequest({"description": "desc", "org_id": "org-1"})
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=_draft())):
            result = await parse_workflow_nl_endpoint(req, None)
        assert isinstance(result, JSONResponse)
        assert result.status_code == 422


@pytest.mark.asyncio
class TestParseWorkflowNLEndpointScope:
    """Wave 12 (BUILDER_REDESIGN_V2_SCOPE.md) — scopeType/scopeSurveyId/
    scopeTagId through the actual HTTP endpoint, using the registry shape
    Nina's Node proxy forwards (`registry.surveys`/`registry.tags`)."""

    async def test_real_survey_mention_resolves_scope_through_endpoint(self):
        from crystalos.main import parse_workflow_nl_endpoint

        draft = _draft(scope_hint="Onboarding Survey")
        req = _FakeRequest({
            "description": "When NPS drops below 30 on the Onboarding Survey, notify support on Slack",
            "org_id": "org-1",
            "registry": REGISTRY_WITH_SCOPE,
        })
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl_endpoint(req, None)

        assert isinstance(result, dict)
        assert result["scopeType"] == "survey"
        assert result["scopeSurveyId"] == "survey-onboarding-1"
        assert result["scopeTagId"] is None

    async def test_real_tag_mention_resolves_scope_through_endpoint(self):
        from crystalos.main import parse_workflow_nl_endpoint

        draft = _draft(scope_hint="VIP")
        req = _FakeRequest({
            "description": "When a VIP response scores low, notify support on Slack",
            "org_id": "org-1",
            "registry": REGISTRY_WITH_SCOPE,
        })
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl_endpoint(req, None)

        assert isinstance(result, dict)
        assert result["scopeType"] == "tag"
        assert result["scopeTagId"] == "tag-vip-1"
        assert result["scopeSurveyId"] is None

    async def test_unmatched_scope_hint_falls_back_to_org_through_endpoint(self):
        """A scope_hint that doesn't match anything real must never surface a
        wrong id through the wire response — falls back to org with a warning,
        exactly like a hallucinated trigger/action would."""
        from crystalos.main import parse_workflow_nl_endpoint

        draft = _draft(scope_hint="Nonexistent Survey", confidence=0.9)
        req = _FakeRequest({"description": "desc", "org_id": "org-1", "registry": REGISTRY_WITH_SCOPE})
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl_endpoint(req, None)

        assert isinstance(result, dict)
        assert result["scopeType"] == "org"
        assert result["scopeSurveyId"] is None
        assert result["scopeTagId"] is None
        assert any("Nonexistent Survey" in w for w in result["warnings"])
        assert result["confidence"] < 0.9

    async def test_no_scope_hint_with_scope_catalog_present_still_defaults_org(self):
        """Even when the registry DOES carry surveys/tags, a description that
        doesn't name one must still default to org, unchanged."""
        from crystalos.main import parse_workflow_nl_endpoint

        draft = _draft(scope_hint=None, confidence=0.9)
        req = _FakeRequest({
            "description": "When NPS drops below 30, notify support on Slack",
            "org_id": "org-1",
            "registry": REGISTRY_WITH_SCOPE,
        })
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await parse_workflow_nl_endpoint(req, None)

        assert result["scopeType"] == "org"
        assert result["scopeSurveyId"] is None
        assert result["scopeTagId"] is None
        assert result["confidence"] == pytest.approx(0.9)
        assert result["warnings"] == []
