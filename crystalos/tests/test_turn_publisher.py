"""Unit tests for lib/turn_publisher.py — TurnEvent telemetry and quality detection."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from crystalos.crystal.context import BrandContext, CrystalContext
from crystalos.lib.turn_publisher import (
    TurnEvent,
    _FRUSTRATION,
    _SATISFACTION,
    detect_quality_signal,
    publish_turn_event,
    _write_turn_event,
    log_capability_gap,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_ctx(brand: BrandContext | None = None) -> CrystalContext:
    return CrystalContext(
        org_id="org-123",
        user_id="user-456",
        survey_id="survey-789",
        scope="survey",
        brand=brand,
    )


def _make_event(**kwargs) -> TurnEvent:
    defaults = dict(
        id="11111111-1111-4111-8111-111111111111",
        org_id="org-123",
        brand_id=None,
        user_id="user-456",
        survey_id="survey-789",
        thread_id="thread-001",
        turn_index=0,
        query="What is the NPS trend?",
        tools_called=[],
        tool_errors=[],
        eval_score=0.85,
        model_used="crystal",
        tokens_in=100,
        tokens_out=200,
        latency_ms=1234,
        specialist_used=None,
        quality_signal=None,
    )
    defaults.update(kwargs)
    return TurnEvent(**defaults)


# ---------------------------------------------------------------------------
# test_publish_turn_event_is_nonblocking
# ---------------------------------------------------------------------------

def test_publish_turn_event_is_nonblocking():
    """publish_turn_event creates an asyncio task and returns immediately without blocking."""
    event = _make_event()
    ctx = _make_ctx()

    with patch("crystalos.lib.turn_publisher.asyncio") as mock_asyncio:
        # create_task should be called once
        publish_turn_event(event, ctx)
        mock_asyncio.create_task.assert_called_once()


# ---------------------------------------------------------------------------
# detect_quality_signal — frustration patterns
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("phrase", [
    "that's wrong",
    "incorrect",
    "not what i asked",
    "try again",
    "that's not right",
    "you're wrong",
    "that doesn't make sense",
    "that's not helpful",
    "stop",
    "nevermind",
    "forget it",
])
def test_detect_quality_signal_frustration_patterns(phrase: str):
    assert detect_quality_signal(phrase) == "negative"


# ---------------------------------------------------------------------------
# detect_quality_signal — satisfaction patterns
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("phrase", [
    "perfect",
    "exactly",
    "great",
    "thanks",
    "helpful",
    "that's what i needed",
    "good job",
    "nice",
    "awesome",
    "thank you",
    "excellent",
])
def test_detect_quality_signal_satisfaction_patterns(phrase: str):
    assert detect_quality_signal(phrase) == "positive"


# ---------------------------------------------------------------------------
# detect_quality_signal — neutral returns None
# ---------------------------------------------------------------------------

def test_detect_quality_signal_neutral_returns_none():
    assert detect_quality_signal("What is the NPS score for last quarter?") is None
    assert detect_quality_signal("Show me the trends") is None
    assert detect_quality_signal("") is None


def test_detect_quality_signal_case_insensitive():
    assert detect_quality_signal("THAT'S WRONG") == "negative"
    assert detect_quality_signal("PERFECT") == "positive"


# ---------------------------------------------------------------------------
# _write_turn_event — mocked DB
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_write_turn_event_writes_to_db():
    """_write_turn_event calls conn.execute with the correct SQL. No real DB needed."""
    event = _make_event()
    ctx = _make_ctx()

    mock_conn = AsyncMock()
    mock_conn_cm = MagicMock()
    mock_conn_cm.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_conn_cm.__aexit__ = AsyncMock(return_value=False)

    mock_pool = MagicMock()
    mock_pool.connection = MagicMock(return_value=mock_conn_cm)

    with patch("crystalos.lib.turn_publisher._pool_conn", return_value=mock_pool):
        await _write_turn_event(event, ctx)

    mock_conn.execute.assert_called_once()
    call_args = mock_conn.execute.call_args[0]
    # First arg is the SQL string
    assert "crystal_turn_events" in call_args[0]
    # Second arg is the params tuple
    params = call_args[1]
    assert params[0] == "11111111-1111-4111-8111-111111111111"  # id (explicit, not DB default)
    assert params[1] == "org-123"  # org_id
    assert params[3] == "user-456"  # user_id


@pytest.mark.asyncio
async def test_write_turn_event_persists_the_exact_id_the_client_saw():
    """The id column value is the same UUID the caller minted and already put on
    the wire (SSE `answer` frame / REST payload) — not the table's own
    DEFAULT gen_random_uuid(). This is the G1 fix: the client-visible turn_id
    and this row's real primary key must be identical."""
    turn_id = "22222222-2222-4222-8222-222222222222"
    event = _make_event(id=turn_id)
    ctx = _make_ctx()

    mock_conn = AsyncMock()
    mock_conn_cm = MagicMock()
    mock_conn_cm.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_conn_cm.__aexit__ = AsyncMock(return_value=False)

    mock_pool = MagicMock()
    mock_pool.connection = MagicMock(return_value=mock_conn_cm)

    with patch("crystalos.lib.turn_publisher._pool_conn", return_value=mock_pool):
        await _write_turn_event(event, ctx)

    call_args = mock_conn.execute.call_args[0]
    sql, params = call_args[0], call_args[1]
    # The INSERT explicitly supplies id (skipping the column default).
    assert sql.split("INSERT INTO crystal_turn_events")[1].split("VALUES")[0].strip().startswith("(id,")
    assert params[0] == turn_id


def test_turn_event_crystalos_version_defaults_to_none():
    """A TurnEvent constructed without crystalos_version still works (backward compatible)."""
    event = _make_event()
    assert event.crystalos_version is None


@pytest.mark.asyncio
async def test_write_turn_event_includes_crystalos_version_in_insert():
    """crystalos_version is threaded into the crystal_turn_events INSERT column list
    and round-trips correctly into the params tuple, in step with the constant at
    crystalos.lib.constants.CRYSTALOS_VERSION."""
    from crystalos.lib.constants import CRYSTALOS_VERSION

    event = _make_event(crystalos_version=CRYSTALOS_VERSION)
    ctx = _make_ctx()

    mock_conn = AsyncMock()
    mock_conn_cm = MagicMock()
    mock_conn_cm.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_conn_cm.__aexit__ = AsyncMock(return_value=False)

    mock_pool = MagicMock()
    mock_pool.connection = MagicMock(return_value=mock_conn_cm)

    with patch("crystalos.lib.turn_publisher._pool_conn", return_value=mock_pool):
        await _write_turn_event(event, ctx)

    call_args = mock_conn.execute.call_args[0]
    sql, params = call_args[0], call_args[1]
    assert "crystalos_version" in sql
    assert params[-1] == CRYSTALOS_VERSION


@pytest.mark.asyncio
async def test_write_turn_event_crystalos_version_defaults_none_in_insert():
    """A TurnEvent that doesn't set crystalos_version still inserts cleanly with
    None in that column's slot — existing callers keep working unchanged."""
    event = _make_event()
    ctx = _make_ctx()

    mock_conn = AsyncMock()
    mock_conn_cm = MagicMock()
    mock_conn_cm.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_conn_cm.__aexit__ = AsyncMock(return_value=False)

    mock_pool = MagicMock()
    mock_pool.connection = MagicMock(return_value=mock_conn_cm)

    with patch("crystalos.lib.turn_publisher._pool_conn", return_value=mock_pool):
        await _write_turn_event(event, ctx)

    call_args = mock_conn.execute.call_args[0]
    params = call_args[1]
    assert params[-1] is None


@pytest.mark.asyncio
async def test_write_turn_event_never_raises_on_db_error():
    """_write_turn_event swallows DB errors and logs a warning — never raises."""
    event = _make_event()
    ctx = _make_ctx()

    with patch("crystalos.lib.turn_publisher._pool_conn", side_effect=RuntimeError("DB down")):
        # Should not raise
        await _write_turn_event(event, ctx)


# ---------------------------------------------------------------------------
# log_capability_gap — fire-and-forget write to crystal_capability_gaps
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_log_capability_gap_writes_to_db():
    """log_capability_gap embeds the query and fires a background write."""
    ctx = _make_ctx()

    mock_embeddings = [[0.1, 0.2, 0.3]]

    with patch("crystalos.lib.turn_publisher.asyncio") as mock_asyncio, \
         patch("crystalos.tools.embeddings.embed_texts", new=AsyncMock(return_value=mock_embeddings)):
        await log_capability_gap(ctx, "Why can't I compare surveys?")
        mock_asyncio.create_task.assert_called_once()


@pytest.mark.asyncio
async def test_log_capability_gap_handles_embed_failure():
    """log_capability_gap handles embedding failures gracefully and still fires the task."""
    ctx = _make_ctx()

    with patch("crystalos.lib.turn_publisher.asyncio") as mock_asyncio, \
         patch("crystalos.tools.embeddings.embed_texts", new=AsyncMock(side_effect=RuntimeError("API down"))):
        # Should not raise
        await log_capability_gap(ctx, "some query")
        # Task still fires with embedding=None
        mock_asyncio.create_task.assert_called_once()


# ── Regression: 2026-08-04 ────────────────────────────────────────────────────

def test_publish_turn_event_is_not_a_coroutine_function():
    """publish_turn_event must stay synchronous.

    agents/crystal.py's telemetry path calls it directly (NOT wrapped in
    asyncio.create_task). It previously WAS wrapped, which passed None to
    create_task() and raised `TypeError: a coroutine was expected, got None` on
    every Crystal turn — silently swallowed by a bare `except Exception: pass`.

    If this function is ever converted to `async def`, that call site must be
    updated to await it (or re-wrap it) in the same change. This test exists to
    force that review rather than let the mismatch return.
    """
    import inspect

    assert not inspect.iscoroutinefunction(publish_turn_event), (
        "publish_turn_event became async — update the call site in "
        "agents/crystal.py (_fire_telemetry) in the same change."
    )


def test_crystal_telemetry_call_site_does_not_wrap_publish_in_create_task():
    """Static guard on the call site itself, so the bug cannot silently return."""
    from pathlib import Path

    src = Path(__file__).resolve().parents[1] / "agents" / "crystal.py"
    text = src.read_text()
    assert "create_task(publish_turn_event" not in text, (
        "publish_turn_event is synchronous; wrapping it in asyncio.create_task() "
        "passes None to create_task() and raises TypeError on every turn."
    )
