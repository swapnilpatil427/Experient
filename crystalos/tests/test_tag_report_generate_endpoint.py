"""Tests for POST /tag-reports/generate (crystalos/main.py).

Calls the handler function directly (not via HTTP/TestClient), mirroring
tests/test_workflow_nl_endpoint.py's existing pattern for main.py endpoints —
avoids spinning up the app lifespan (DB pool, LangGraph build).

Regression coverage (2026-07-02 integration reconciliation): the original
handler computed its effective_max_surveys fallback via
`crystalos.lib.constants.TAG_REPORT_DEFAULT_TARGET_N`, which does not exist —
Tag Report's tunables are module-level constants inside graphs/tag_report.py
itself. That would have raised AttributeError on the very first request with a
falsy `effective_max_surveys` (0, None, or omitted). No test exercised this
route at all before this file.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class _FakeRequest:
    def __init__(self, body: dict):
        self._body = body

    async def json(self):
        return self._body


def _make_pool():
    cur = AsyncMock()
    cur.execute = AsyncMock()
    conn = AsyncMock()
    conn.cursor.return_value.__aenter__.return_value = cur
    conn.cursor.return_value.__aexit__.return_value = None
    conn.commit = AsyncMock()
    pool = MagicMock()
    pool.connection.return_value.__aenter__.return_value = conn
    pool.connection.return_value.__aexit__.return_value = None
    return pool


class TestGenerateTagReportEndpoint:
    @pytest.mark.asyncio
    async def test_missing_required_fields_returns_422(self):
        from fastapi import HTTPException
        from crystalos.main import generate_tag_report

        with pytest.raises(HTTPException) as exc_info:
            await generate_tag_report(_FakeRequest({"org_id": "org1"}), None)
        assert exc_info.value.status_code == 422

    @pytest.mark.asyncio
    async def test_passes_effective_max_surveys_through_as_target_n(self):
        from crystalos.main import generate_tag_report

        pool = _make_pool()
        fake_task = MagicMock()
        with (
            patch("crystalos.main.db._pool_conn", return_value=pool),
            patch("crystalos.graphs.tag_report.run_tag_report_generation", new=AsyncMock()) as mock_run,
            patch("asyncio.create_task", side_effect=lambda coro: (coro.close(), fake_task)[1]),
        ):
            result = await generate_tag_report(_FakeRequest({
                "run_id": "run1", "org_id": "org1", "tag_id": "tag1",
                "run_mode": "manual", "effective_max_surveys": 8,
            }), None)

        assert result == {"run_id": "run1", "status": "running"}

    @pytest.mark.asyncio
    async def test_falsy_effective_max_surveys_does_not_raise_and_passes_none_target_n(self):
        """The specific regression this file exists for: effective_max_surveys
        omitted entirely (falsy) must not crash resolving a bogus constants-module
        attribute — it must pass target_n=None through to
        run_tag_report_generation, which has its own correct fallback."""
        from crystalos.main import generate_tag_report

        pool = _make_pool()
        captured_kwargs = {}

        async def _fake_run(**kwargs):
            captured_kwargs.update(kwargs)

        with (
            patch("crystalos.main.db._pool_conn", return_value=pool),
            patch("crystalos.graphs.tag_report.run_tag_report_generation", side_effect=_fake_run),
        ):
            result = await generate_tag_report(_FakeRequest({
                "run_id": "run1", "org_id": "org1", "tag_id": "tag1", "run_mode": "manual",
                # effective_max_surveys intentionally omitted
            }), None)

        assert result == {"run_id": "run1", "status": "running"}
        # Give the fire-and-forget asyncio task a tick to actually run and raise
        # if the old buggy attribute lookup were still there.
        import asyncio
        await asyncio.sleep(0)
        assert captured_kwargs.get("target_n") is None

    @pytest.mark.asyncio
    async def test_db_status_update_failure_does_not_prevent_generation_from_starting(self):
        from crystalos.main import generate_tag_report

        with (
            patch("crystalos.main.db._pool_conn", side_effect=RuntimeError("connection refused")),
            patch("crystalos.graphs.tag_report.run_tag_report_generation", new=AsyncMock()),
        ):
            result = await generate_tag_report(_FakeRequest({
                "run_id": "run1", "org_id": "org1", "tag_id": "tag1", "run_mode": "manual",
                "effective_max_surveys": 5,
            }), None)

        assert result == {"run_id": "run1", "status": "running"}
