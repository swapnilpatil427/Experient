"""Tests for POST /topics/backfill (crystalos/main.py).

Calls the handler function directly (not via HTTP/TestClient), mirroring
tests/test_tag_report_generate_endpoint.py's existing pattern for main.py
endpoints — avoids spinning up the app lifespan (DB pool, LangGraph build).
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class _FakeRequest:
    def __init__(self, body: dict):
        self._body = body

    async def json(self):
        return self._body


class TestStartTopicBackfillEndpoint:
    @pytest.mark.asyncio
    async def test_missing_required_fields_returns_422(self):
        from fastapi import HTTPException
        from crystalos.main import start_topic_backfill

        with pytest.raises(HTTPException) as exc_info:
            await start_topic_backfill(_FakeRequest({"org_id": "org1"}), None)
        assert exc_info.value.status_code == 422

    @pytest.mark.asyncio
    async def test_starts_background_task_and_returns_immediately(self):
        from crystalos.main import start_topic_backfill

        fake_task = MagicMock()
        with (
            patch("crystalos.lib.topic_backfill.run_topic_backfill", new=AsyncMock()) as mock_run,
            patch("asyncio.create_task", side_effect=lambda coro: (coro.close(), fake_task)[1]) as mock_create_task,
        ):
            result = await start_topic_backfill(_FakeRequest({
                "survey_id": "s1", "org_id": "org1", "run_id": "run1",
            }), None)

        assert result == {"status": "started", "run_id": "run1"}
        mock_create_task.assert_called_once()

    @pytest.mark.asyncio
    async def test_does_not_precreate_or_insert_any_row(self):
        """Unlike /insights/runs (manual modes precreate an insight_reports row),
        this endpoint must never touch the DB directly — Node already inserted
        the agent_runs row before calling here; this endpoint only starts the
        background task that reports INTO it."""
        from crystalos.main import start_topic_backfill

        db_mock = MagicMock(side_effect=AssertionError("must not touch the DB directly"))
        with (
            patch("crystalos.main.db._pool_conn", db_mock),
            patch("crystalos.lib.topic_backfill.run_topic_backfill", new=AsyncMock()),
            patch("asyncio.create_task", side_effect=lambda coro: (coro.close(), MagicMock())[1]),
        ):
            result = await start_topic_backfill(_FakeRequest({
                "survey_id": "s1", "org_id": "org1", "run_id": "run1",
            }), None)

        assert result == {"status": "started", "run_id": "run1"}
        db_mock.assert_not_called()
