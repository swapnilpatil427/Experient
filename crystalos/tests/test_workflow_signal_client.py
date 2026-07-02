"""Tests for lib/workflow_signal_client.py — CrystalOS -> Node's
POST /api/internal/workflows/signal (WORKFLOW_SIGNAL_CONTRACT.md §2).

httpx.AsyncClient is mocked (mirrors tests/test_sla_sweep.py's existing
pattern for outbound webhook calls) — no real network calls, per
crystalos/CLAUDE.md testing rules.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from crystalos.lib.workflow_signal_client import emit_workflow_signal


def _mock_client(status_code=202, json_body=None):
    mock_response = MagicMock()
    mock_response.status_code = status_code
    mock_response.json = MagicMock(return_value=json_body or {"accepted": True, "published": True})
    mock_response.text = "response body"

    mock_http_client = AsyncMock()
    mock_http_client.__aenter__ = AsyncMock(return_value=mock_http_client)
    mock_http_client.__aexit__ = AsyncMock(return_value=False)
    mock_http_client.post = AsyncMock(return_value=mock_response)
    return mock_http_client


class TestEmitWorkflowSignal:
    @pytest.mark.asyncio
    async def test_successful_delivery_returns_true(self):
        client = _mock_client(202, {"accepted": True, "published": True})
        with patch("httpx.AsyncClient", return_value=client):
            result = await emit_workflow_signal(
                org_id="org-1", signal_type="sentiment_spike", confidence=0.8, survey_id="s1",
            )
        assert result is True
        client.post.assert_called_once()
        call_kwargs = client.post.call_args
        url = call_kwargs[0][0]
        assert url.endswith("/api/internal/workflows/signal")
        body = call_kwargs[1]["json"]
        assert body["org_id"] == "org-1"
        assert body["signal_type"] == "sentiment_spike"
        assert body["confidence"] == 0.8
        assert body["survey_id"] == "s1"
        headers = call_kwargs[1]["headers"]
        assert "X-Internal-Key" in headers

    @pytest.mark.asyncio
    async def test_body_uses_snake_case_field_names(self):
        """Per WORKFLOW_SIGNAL_CONTRACT.md §2.3.2 — must match workflowSignalSchema exactly."""
        client = _mock_client()
        with patch("httpx.AsyncClient", return_value=client):
            await emit_workflow_signal(
                org_id="org-1", signal_type="anomaly_detected", confidence=0.9,
                survey_id="s1", detected_at="2026-07-01T00:00:00Z", source_run_id="run-1",
                payload={"metric": "NPS"},
            )
        body = client.post.call_args[1]["json"]
        assert set(body.keys()) == {"org_id", "signal_type", "confidence", "payload", "survey_id", "detected_at", "source_run_id"}
        assert body["detected_at"] == "2026-07-01T00:00:00Z"
        assert body["source_run_id"] == "run-1"
        assert body["payload"] == {"metric": "NPS"}

    @pytest.mark.asyncio
    async def test_published_false_returns_false(self):
        """Backend accepted but Redis was down (202 {accepted:true, published:false})."""
        client = _mock_client(202, {"accepted": True, "published": False})
        with patch("httpx.AsyncClient", return_value=client):
            result = await emit_workflow_signal(org_id="org-1", signal_type="sentiment_spike", confidence=0.8)
        assert result is False

    @pytest.mark.asyncio
    async def test_non_202_status_returns_false(self):
        client = _mock_client(400, {"error": "bad request"})
        with patch("httpx.AsyncClient", return_value=client):
            result = await emit_workflow_signal(org_id="org-1", signal_type="sentiment_spike", confidence=0.8)
        assert result is False

    @pytest.mark.asyncio
    async def test_network_failure_never_raises(self):
        mock_http_client = AsyncMock()
        mock_http_client.__aenter__ = AsyncMock(return_value=mock_http_client)
        mock_http_client.__aexit__ = AsyncMock(return_value=False)
        mock_http_client.post = AsyncMock(side_effect=httpx.ConnectError("connection refused"))
        with patch("httpx.AsyncClient", return_value=mock_http_client):
            result = await emit_workflow_signal(org_id="org-1", signal_type="sentiment_spike", confidence=0.8)
        assert result is False

    @pytest.mark.asyncio
    async def test_missing_org_id_returns_false_without_calling_out(self):
        client = _mock_client()
        with patch("httpx.AsyncClient", return_value=client):
            result = await emit_workflow_signal(org_id="", signal_type="sentiment_spike", confidence=0.8)
        assert result is False
        client.post.assert_not_called()

    @pytest.mark.asyncio
    async def test_default_payload_is_empty_dict_not_none(self):
        client = _mock_client()
        with patch("httpx.AsyncClient", return_value=client):
            await emit_workflow_signal(org_id="org-1", signal_type="new_theme_detected", confidence=0.7)
        body = client.post.call_args[1]["json"]
        assert body["payload"] == {}
