"""Tests for POST /insights/crystal/stream (crystalos/main.py's crystal_stream_endpoint).

Wave 15 gate (docs/automation-hub/TRACKER.md "Wave 15") — Kenji's Phase 3
verification. `crystal_stream_endpoint` builds `CrystalInput` via EXPLICIT
keyword arguments (not `CrystalInput(**body)` the way the sibling
`/insights/crystal` non-streaming endpoint does), so any `CrystalInput` field
not explicitly given a `body.get(...)` line is silently dropped — a real bug
class. Amara found and fixed this for `surface`/`builder_draft`/
`workflow_registry` (Wave 15). This file:

1. Systematically sweeps EVERY field `CrystalInput` declares against the
   endpoint's explicit-kwargs block, so a future field addition that forgets
   its `body.get(...)` line fails a test immediately instead of silently
   no-op'ing (exactly the class of bug this wave's fix addressed).
2. Regression-covers a SIBLING bug found during this sweep: `tag_ids` (used
   for group-scope Crystal conversations, `agents/crystal.py` line ~891) was
   declared on `CrystalInput` but never forwarded here — group-scoped
   conversations via the SSE stream endpoint silently lost their tag scope.
   Fixed alongside this test (single added `tag_ids=body.get("tag_ids")` line).
3. Proves the full builder-context wire shape survives the endpoint's request
   parsing byte-for-byte: a realistic `builder_draft`/`workflow_registry`
   payload (matching the exact shape Nina's `backend/src/routes/experience.ts`
   forwards) ends up on `CrystalInput` unmodified.

Calls the handler function directly (not via HTTP/TestClient) with a fake
Request, mirroring tests/test_workflow_nl_endpoint.py's existing pattern for
main.py endpoints — avoids spinning up the app lifespan (DB pool, LangGraph
build).
"""
from __future__ import annotations

import inspect
from unittest.mock import AsyncMock, patch

import pytest

from crystalos.agents.crystal import CrystalInput


class _FakeRequest:
    def __init__(self, body: dict):
        self._body = body

    async def json(self):
        return self._body


async def _drain(agen):
    events = []
    async for chunk in agen:
        events.append(chunk)
    return events


@pytest.mark.asyncio
class TestCrystalStreamEndpointFieldForwarding:
    """Systematic sweep: every settable CrystalInput field must have a
    corresponding body.get(...) passthrough in crystal_stream_endpoint."""

    async def _build_input_via_endpoint(self, body: dict) -> CrystalInput:
        """Drive crystal_stream_endpoint with a captured CrystalInput.

        _run_skill_stream is patched to immediately return (no real routing/
        synthesis) and to capture the `inp` it was constructed with, since
        the endpoint doesn't return CrystalInput directly — it only builds it
        internally before handing off to the stream function.
        """
        captured: dict = {}

        async def _fake_stream(inp, request=None, debug=False):
            captured["inp"] = inp
            return
            yield  # pragma: no cover — makes this an async generator

        from crystalos.main import crystal_stream_endpoint

        req = _FakeRequest(body)
        with (
            patch("crystalos.agents.crystal._run_skill_stream", new=_fake_stream),
            patch("crystalos.lib.security.check_survey_access", new=AsyncMock(return_value={"id": body.get("survey_id")})),
        ):
            response = await crystal_stream_endpoint(req, None)
            await _drain(response.body_iterator)

        assert "inp" in captured, "handler never invoked _run_skill_stream — endpoint short-circuited"
        return captured["inp"]

    async def test_every_declared_field_has_a_body_get_passthrough(self):
        """Reads crystal_stream_endpoint's own source and asserts, for every
        CrystalInput field name, that the literal `body.get("<field>"` (or a
        direct `<field>=` from a validated/derived local, for the handful of
        fields requiring extra validation like user_role) appears in the
        handler's explicit-construction block. This is the general form of
        the check that would have caught both the original surface/
        builder_draft/workflow_registry gap Amara fixed AND the tag_ids
        sibling bug this test file's fix addresses — re-run automatically
        whenever a new CrystalInput field is added."""
        from crystalos import main as main_module

        source = inspect.getsource(main_module.crystal_stream_endpoint)

        # Fields validated/derived through a local variable before being passed
        # in (not a direct body.get(...) inline) — still genuinely forwarded,
        # just via an intermediate name. Everything else must appear as a
        # literal body.get("<field>") call in the handler source.
        derived_locals = {
            "survey_id": "survey_id=survey_id",
            "org_id": "org_id=org_id",
            "user_role": "user_role=user_role",
        }

        for field_name in CrystalInput.model_fields:
            if field_name in derived_locals:
                assert derived_locals[field_name] in source, (
                    f"CrystalInput.{field_name} expected via derived local "
                    f"'{derived_locals[field_name]}' but not found in "
                    f"crystal_stream_endpoint source"
                )
                continue
            expected = f'body.get("{field_name}"'
            assert expected in source, (
                f"CrystalInput.{field_name} is declared but crystal_stream_endpoint "
                f"never does `{expected}...)` — this field is silently dropped for "
                f"every SSE-stream Crystal request (the exact bug class Wave 15's "
                f"surface/builder_draft/workflow_registry fix addressed)."
            )

    async def test_tag_ids_forwarded_regression(self):
        """Regression for the sibling bug found during the Wave 15 field sweep:
        tag_ids (group-scope Crystal conversations) was declared on CrystalInput
        but never forwarded by crystal_stream_endpoint, unlike the sibling
        non-streaming /insights/crystal endpoint (CrystalInput(**body), which
        forwards everything). Fixed with a single body.get("tag_ids") line."""
        inp = await self._build_input_via_endpoint({
            "survey_id": "",
            "org_id": "org-1",
            "message": "How is the Onboarding group trending?",
            "scope": "group",
            "tag_ids": ["tag-onboarding", "tag-vip"],
        })
        assert inp.tag_ids == ["tag-onboarding", "tag-vip"]

    async def test_tag_ids_absent_defaults_to_none_byte_identical(self):
        """Every existing non-group-scope caller omits tag_ids entirely — must
        default to None exactly as before this fix, not e.g. an empty list."""
        inp = await self._build_input_via_endpoint({
            "survey_id": "s1",
            "org_id": "org-1",
            "message": "What is our NPS trend?",
        })
        assert inp.tag_ids is None


@pytest.mark.asyncio
class TestCrystalStreamEndpointBuilderContextWireShape:
    """End-to-end-shaped proof: a realistic builder_draft/workflow_registry
    payload — matching the EXACT shape backend/src/routes/experience.ts
    forwards in `agentBody` — survives crystal_stream_endpoint's request
    parsing into CrystalInput unmodified. Traces the backend->CrystalOS half
    of the Wave 15 contract (the frontend->backend half is covered by
    backend/src/__tests__/experienceCrystalStreamBuilderContext.test.js,
    which proves the Node proxy produces this exact agentBody shape)."""

    async def test_realistic_builder_draft_and_registry_survive_unmodified(self):
        # This is the exact agentBody shape experience.ts's isBuilderContext
        # branch constructs: spread of the (already Wave-15-augmented) request
        # body, plus workflow_registry attached from registry() + surveys/tags
        # query rows, per docs/automation-hub/TRACKER.md Wave 15 + Nina's
        # experienceCrystalStreamBuilderContext.test.js fixtures.
        builder_draft = {
            "mode": "sentence",
            "triggerType": "score.nps_drop",
            "scopeSelection": {"type": "survey", "surveyId": "s1"},
            "conditionClauses": [{"field": "nps", "op": "lt", "value": "30"}],
            "actions": [{"action": "notify.slack", "config": {"channel": "#cx"}}],
            "workflowName": "NPS drop alert",
            "isEditMode": False,
        }
        workflow_registry = {
            "triggers": [{"type": "score.nps_drop", "category": "Score", "label": "NPS dropped"}],
            "conditionFields": [{"field": "nps", "label": "NPS score", "kind": "number"}],
            "conditionOperators": ["lt", "gt"],
            "actions": [{"action": "notify.slack", "category": "Notify", "label": "Slack message", "live": True}],
            "surveys": [{"id": "s1", "name": "Q3 NPS Survey"}, {"id": "s2", "name": "Onboarding CSAT"}],
            "tags": [{"id": "t1", "name": "Onboarding"}],
        }
        agent_body = {
            "message": "Help me finish this workflow",
            "org_id": "org-1",
            "user_id": "user-1",
            "scope": "org",
            "insights": [],
            "topics": [],
            "metrics": {},
            "survey_title": "",
            "survey_response_count": 0,
            "surface": "workflow_builder",
            "workflow_registry": workflow_registry,
            "builder_draft": builder_draft,
        }

        captured: dict = {}

        async def _fake_stream(inp, request=None, debug=False):
            captured["inp"] = inp
            return
            yield  # pragma: no cover

        from crystalos.main import crystal_stream_endpoint

        req = _FakeRequest(agent_body)
        with patch("crystalos.agents.crystal._run_skill_stream", new=_fake_stream):
            response = await crystal_stream_endpoint(req, None)
            events = await _drain(response.body_iterator)

        assert any("[DONE]" in e for e in events)
        inp = captured["inp"]

        # Exact byte-for-byte round trip — no re-shaping, key renaming, or
        # partial-field loss anywhere in the endpoint's parsing.
        assert inp.surface == "workflow_builder"
        assert inp.builder_draft == builder_draft
        assert inp.workflow_registry == workflow_registry
        # Sanity: nested structures aren't copied-by-reference-then-mutated
        # anywhere in between (would still be `==` but worth pinning `is`
        # absence of accidental identity assumptions downstream is out of
        # scope here — equality is the contract, not identity).
        assert inp.builder_draft["actions"] == [{"action": "notify.slack", "config": {"channel": "#cx"}}]
        assert inp.workflow_registry["surveys"] == workflow_registry["surveys"]

    async def test_non_builder_request_omits_keys_and_uses_defaults(self):
        """Byte-identical proof at the endpoint layer: a plain Insights-page
        request (no surface/builder_draft/workflow_registry keys at all, as
        sent by every pre-Wave-15 caller) must produce a CrystalInput with the
        untouched defaults — not None-as-a-value-that-was-set, but the same
        default the field declares."""
        agent_body = {
            "message": "What is our NPS trend?",
            "org_id": "org-1",
            "user_id": "user-1",
            "scope": "survey",
            "survey_id": "s1",
            "insights": [],
            "topics": [],
            "metrics": {},
        }
        captured: dict = {}

        async def _fake_stream(inp, request=None, debug=False):
            captured["inp"] = inp
            return
            yield  # pragma: no cover

        from crystalos.main import crystal_stream_endpoint

        req = _FakeRequest(agent_body)
        with (
            patch("crystalos.agents.crystal._run_skill_stream", new=_fake_stream),
            patch("crystalos.lib.security.check_survey_access", new=AsyncMock(return_value={"id": "s1"})),
        ):
            response = await crystal_stream_endpoint(req, None)
            await _drain(response.body_iterator)

        inp = captured["inp"]
        assert inp.surface == "insights"
        assert inp.builder_draft is None
        assert inp.workflow_registry is None
        assert inp.tag_ids is None
