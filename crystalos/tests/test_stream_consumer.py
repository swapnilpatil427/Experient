"""Smoke tests for the Redis Streams response consumer.

Tests cover:
  - _should_trigger threshold logic (count-based and time-based)
  - Batching accumulation across multiple events
  - _trigger_insights is called (mocked) when threshold is met
  - consume_events gracefully degrades when Redis is unavailable

All external I/O (Redis, Postgres, httpx) is mocked.
"""
from __future__ import annotations

import asyncio
import importlib
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Helpers to reset module-level state between tests
# ---------------------------------------------------------------------------

def _reset_batches():
    """Return a fresh defaultdict matching the shape used by the consumer."""
    return defaultdict(lambda: {"org_id": "", "count": 0, "last_trigger": None})


def _reset_tagging_batches():
    """Return a fresh defaultdict matching the shape used by _tagging_batches."""
    return defaultdict(lambda: {"org_id": "", "count": 0})


# ---------------------------------------------------------------------------
# TIME_THRESHOLD_MINUTES defaults by AGENTS_ENV (module-load-time computation)
# ---------------------------------------------------------------------------

class TestTimeThresholdDefaultsByAgentsEnv:
    """Regression tests (2026-07-03, still applicable 2026-07-04): TIME_THRESHOLD_
    MINUTES is computed once at import time from AGENTS_ENV — this module previously
    checked for "development"/"local" (values AGENTS_ENV is never actually set to
    anywhere in this codebase) and defaulted to "production". NEW_RESPONSE_THRESHOLD
    is no longer part of this — as of 2026-07-04 it's resolved per survey/org via
    resolve_stream_response_threshold (see TestShouldTrigger* below and
    test_insight_settings.py) instead of a flat module constant."""

    def _time_threshold_for(self, agents_env: str | None, **overrides: str) -> int:
        """Reload the module under a given AGENTS_ENV and capture the resulting
        VALUE (not the module reference) before restoring real state — the module
        object is a singleton, so returning it directly would let the restoring
        reload in `finally` overwrite the very attribute being tested, before the
        caller ever gets to assert on it."""
        env_backup = dict(os.environ)
        try:
            for key in ("AGENTS_ENV", "INSIGHT_TIME_THRESHOLD_MIN"):
                os.environ.pop(key, None)
            if agents_env is not None:
                os.environ["AGENTS_ENV"] = agents_env
            os.environ.update(overrides)
            import crystalos.consumers.response_stream as rs
            importlib.reload(rs)
            return rs.TIME_THRESHOLD_MINUTES
        finally:
            os.environ.clear()
            os.environ.update(env_backup)
            import crystalos.consumers.response_stream as rs
            importlib.reload(rs)

    def test_dev_env_uses_fast_threshold(self):
        assert self._time_threshold_for("dev") == 1

    def test_dev_paid_env_uses_fast_threshold(self):
        assert self._time_threshold_for("dev-paid") == 1

    def test_production_env_uses_slow_threshold(self):
        assert self._time_threshold_for("production") == 5

    def test_unset_agents_env_defaults_to_dev_fast_threshold(self):
        # AGENTS_ENV unset must default the same way every other module in this
        # codebase does (checkpoint_store.py, constants.py, security.py: "dev") —
        # not silently behave as production, which is what the old buggy default
        # of "production" here did.
        assert self._time_threshold_for(None) == 1

    def test_explicit_override_env_var_still_wins_regardless_of_agents_env(self):
        assert self._time_threshold_for("production", INSIGHT_TIME_THRESHOLD_MIN="2") == 2


# ---------------------------------------------------------------------------
# _should_trigger — count threshold (resolved per survey/org, 2026-07-04)
# ---------------------------------------------------------------------------

class TestShouldTriggerCountThreshold:
    """NEW_RESPONSE_THRESHOLD is no longer a flat module constant — _should_trigger
    now resolves it per survey/org via resolve_stream_response_threshold (the same
    UI-configurable stream_response_threshold setting node_resolve_context's
    skip-run gate already honoured). Mocked at its source
    (crystalos.lib.insight_settings.resolve_stream_response_threshold) since
    response_stream.py imports it locally inside _should_trigger on every call,
    not as a module-level name that could be patched on response_stream itself."""

    def setup_method(self):
        self._patcher = patch(
            "crystalos.lib.insight_settings.resolve_stream_response_threshold",
            new=AsyncMock(return_value=10),
        )
        self._patcher.start()

    def teardown_method(self):
        self._patcher.stop()

    @pytest.mark.asyncio
    async def test_triggers_at_threshold(self):
        from crystalos.consumers import response_stream as rs

        original = rs._batches
        rs._batches = _reset_batches()
        try:
            rs._batches["survey-1"]["count"] = 10  # mocked threshold
            assert await rs._should_trigger("survey-1") is True
        finally:
            rs._batches = original

    @pytest.mark.asyncio
    async def test_does_not_trigger_below_threshold(self):
        from crystalos.consumers import response_stream as rs

        original = rs._batches
        rs._batches = _reset_batches()
        try:
            rs._batches["survey-1"]["count"] = 9
            assert await rs._should_trigger("survey-1") is False
        finally:
            rs._batches = original

    @pytest.mark.asyncio
    async def test_triggers_above_threshold(self):
        from crystalos.consumers import response_stream as rs

        original = rs._batches
        rs._batches = _reset_batches()
        try:
            rs._batches["survey-1"]["count"] = 15
            assert await rs._should_trigger("survey-1") is True
        finally:
            rs._batches = original

    @pytest.mark.asyncio
    async def test_resolves_threshold_using_the_batch_org_id(self):
        """_should_trigger must pass the batch's tracked org_id through to the
        resolver (survey/org-scoped resolution, not global) — regression test for
        the exact bug this change fixes: previously a single flat threshold
        applied to every survey org-wide regardless of that survey's own or its
        org's configured stream_response_threshold."""
        from crystalos.consumers import response_stream as rs
        from crystalos.lib import insight_settings

        original = rs._batches
        rs._batches = _reset_batches()
        try:
            rs._batches["survey-9"]["org_id"] = "org-42"
            rs._batches["survey-9"]["count"] = 1
            await rs._should_trigger("survey-9")
            insight_settings.resolve_stream_response_threshold.assert_awaited_with("survey-9", "org-42")
        finally:
            rs._batches = original


# ---------------------------------------------------------------------------
# _should_trigger_tagging — the response-tagging batch-size gate (2026-07-04)
# ---------------------------------------------------------------------------

class TestShouldTriggerTagging:
    """response_tagging_batch_size gates a SEPARATE, much lighter-weight sweep
    (lib.response_tagging.tag_untagged_responses) from the full-report threshold
    above. Purely count-based — no time fallback, unlike _should_trigger."""

    def setup_method(self):
        self._patcher = patch(
            "crystalos.lib.insight_settings.resolve_response_tagging_batch_size",
            new=AsyncMock(return_value=3),
        )
        self._patcher.start()

    def teardown_method(self):
        self._patcher.stop()

    @pytest.mark.asyncio
    async def test_triggers_at_batch_size(self):
        from crystalos.consumers import response_stream as rs

        original = rs._tagging_batches
        rs._tagging_batches = _reset_tagging_batches()
        try:
            rs._tagging_batches["survey-1"]["count"] = 3
            assert await rs._should_trigger_tagging("survey-1") is True
        finally:
            rs._tagging_batches = original

    @pytest.mark.asyncio
    async def test_does_not_trigger_below_batch_size(self):
        from crystalos.consumers import response_stream as rs

        original = rs._tagging_batches
        rs._tagging_batches = _reset_tagging_batches()
        try:
            rs._tagging_batches["survey-1"]["count"] = 2
            assert await rs._should_trigger_tagging("survey-1") is False
        finally:
            rs._tagging_batches = original

    @pytest.mark.asyncio
    async def test_default_batch_size_of_one_triggers_on_first_event(self):
        """The whole point of the default: every single response gets tagged
        immediately, not batched."""
        from crystalos.consumers import response_stream as rs
        from crystalos.lib import insight_settings

        with patch.object(insight_settings, "resolve_response_tagging_batch_size", new=AsyncMock(return_value=1)):
            original = rs._tagging_batches
            rs._tagging_batches = _reset_tagging_batches()
            try:
                rs._tagging_batches["survey-1"]["count"] = 1
                assert await rs._should_trigger_tagging("survey-1") is True
            finally:
                rs._tagging_batches = original

    @pytest.mark.asyncio
    async def test_resolves_batch_size_using_the_tagging_batch_org_id(self):
        from crystalos.consumers import response_stream as rs
        from crystalos.lib import insight_settings

        original = rs._tagging_batches
        rs._tagging_batches = _reset_tagging_batches()
        try:
            rs._tagging_batches["survey-9"]["org_id"] = "org-42"
            rs._tagging_batches["survey-9"]["count"] = 1
            await rs._should_trigger_tagging("survey-9")
            insight_settings.resolve_response_tagging_batch_size.assert_awaited_with("survey-9", "org-42")
        finally:
            rs._tagging_batches = original


# ---------------------------------------------------------------------------
# _run_tagging_sweep — counter bookkeeping around tag_untagged_responses
# ---------------------------------------------------------------------------

class TestRunTaggingSweep:
    @pytest.mark.asyncio
    async def test_subtracts_only_the_triggering_count_and_clears_pending(self):
        from crystalos.consumers import response_stream as rs

        original = rs._tagging_batches
        rs._tagging_batches = _reset_tagging_batches()
        rs._pending_tagging.add("survey-1")
        try:
            rs._tagging_batches["survey-1"]["count"] = 3
            tag_mock = AsyncMock(return_value={"tagged": 3})
            with patch("crystalos.lib.response_tagging.tag_untagged_responses", tag_mock):
                # Simulate a new event arriving mid-sweep (after the count was
                # captured but before tag_untagged_responses resolves) by bumping
                # the counter inside the mock itself.
                async def _side_effect(survey_id, org_id):
                    rs._tagging_batches[survey_id]["count"] += 1
                    return {"tagged": 3}
                tag_mock.side_effect = _side_effect

                await rs._run_tagging_sweep("survey-1", "org-1")

            tag_mock.assert_awaited_once_with("survey-1", "org-1")
            # 3 (triggering) + 1 (mid-flight) - 3 (subtracted) = 1 remaining
            assert rs._tagging_batches["survey-1"]["count"] == 1
            assert "survey-1" not in rs._pending_tagging
        finally:
            rs._tagging_batches = original
            rs._pending_tagging.discard("survey-1")

    @pytest.mark.asyncio
    async def test_never_raises_even_if_tag_untagged_responses_errors(self):
        """tag_untagged_responses already catches everything internally, but this
        wrapper must never propagate even an unexpected exception — a stream
        consumer task crashing would silently stop future tagging for that
        survey."""
        from crystalos.consumers import response_stream as rs

        original = rs._tagging_batches
        rs._tagging_batches = _reset_tagging_batches()
        rs._pending_tagging.add("survey-1")
        try:
            rs._tagging_batches["survey-1"]["count"] = 1
            with patch(
                "crystalos.lib.response_tagging.tag_untagged_responses",
                new=AsyncMock(side_effect=RuntimeError("unexpected")),
            ):
                await rs._run_tagging_sweep("survey-1", "org-1")  # must not raise
            assert "survey-1" not in rs._pending_tagging
        finally:
            rs._tagging_batches = original
            rs._pending_tagging.discard("survey-1")

    @pytest.mark.asyncio
    async def test_never_raises_and_clears_pending_even_if_the_import_itself_fails(self):
        """Regression test for the exact bug fixed 2026-07-06: the import of
        tag_untagged_responses used to sit BEFORE the try block. If the import
        itself ever failed, the finally never ran, and _pending_tagging never
        got cleared — the survey would be silently, permanently skipped by
        every future response event with no error ever surfacing. Simulated
        here by forcing the import machinery to raise ImportError."""
        import sys
        from crystalos.consumers import response_stream as rs

        original = rs._tagging_batches
        rs._tagging_batches = _reset_tagging_batches()
        rs._pending_tagging.add("survey-1")
        try:
            rs._tagging_batches["survey-1"]["count"] = 1
            with patch.dict(sys.modules, {"crystalos.lib.response_tagging": None}):
                await rs._run_tagging_sweep("survey-1", "org-1")  # must not raise
            assert "survey-1" not in rs._pending_tagging
            assert rs._tagging_batches["survey-1"]["count"] == 0
        finally:
            rs._tagging_batches = original
            rs._pending_tagging.discard("survey-1")


# ---------------------------------------------------------------------------
# Tagging sweep wired into the main consumer loop (Phase 2a)
# ---------------------------------------------------------------------------

class TestTaggingSweepConsumerLoopIntegration:
    @pytest.mark.asyncio
    async def test_tagging_counter_increments_alongside_report_counter(self):
        from crystalos.consumers import response_stream as rs

        original_batches = rs._batches
        rs._batches = _reset_batches()
        original_tagging_batches = rs._tagging_batches
        rs._tagging_batches = _reset_tagging_batches()

        events = [
            {"survey_id": "s1", "org_id": "org1", "response_id": "r1"},
            {"survey_id": "s1", "org_id": "org1", "response_id": "r2"},
        ]

        async def fake_consume(**kwargs):
            yield events
            return

        with (
            patch("crystalos.consumers.response_stream.consume_events", fake_consume),
            patch("crystalos.consumers.response_stream._should_trigger", new=AsyncMock(return_value=False)),
            patch("crystalos.consumers.response_stream._should_trigger_tagging", new=AsyncMock(return_value=False)),
            patch("crystalos.consumers.response_stream._get_total_response_count", new=AsyncMock(return_value=0)),
            patch("crystalos.consumers.response_stream.should_trigger_progressive_tier", new=AsyncMock(return_value=None)),
        ):
            try:
                await asyncio.wait_for(rs.run_response_stream_consumer(), timeout=1.0)
            except asyncio.TimeoutError:
                pass

        try:
            assert rs._batches["s1"]["count"] == 2
            assert rs._tagging_batches["s1"]["count"] == 2
            assert rs._tagging_batches["s1"]["org_id"] == "org1"
        finally:
            rs._batches = original_batches
            rs._tagging_batches = original_tagging_batches

    @pytest.mark.asyncio
    async def test_tagging_sweep_fires_independently_of_report_trigger(self):
        """The core design point: a tagging sweep must fire even when the full
        report/checkpoint trigger does NOT (default batch size 1 vs. report
        threshold 100 — these are never coupled)."""
        from crystalos.consumers import response_stream as rs

        original_batches = rs._batches
        rs._batches = _reset_batches()
        original_tagging_batches = rs._tagging_batches
        rs._tagging_batches = _reset_tagging_batches()

        event = {"survey_id": "s1", "org_id": "org1", "response_id": "r1"}

        async def fake_consume(**kwargs):
            yield [event]
            return

        sweep_called_for: list[tuple] = []

        async def fake_sweep(survey_id: str, org_id: str) -> None:
            sweep_called_for.append((survey_id, org_id))

        with (
            patch("crystalos.consumers.response_stream.consume_events", fake_consume),
            patch("crystalos.consumers.response_stream._should_trigger", new=AsyncMock(return_value=False)),
            patch("crystalos.consumers.response_stream._should_trigger_tagging", new=AsyncMock(return_value=True)),
            patch("crystalos.consumers.response_stream._run_tagging_sweep", fake_sweep),
            patch("crystalos.consumers.response_stream._get_total_response_count", new=AsyncMock(return_value=0)),
            patch("crystalos.consumers.response_stream.should_trigger_progressive_tier", new=AsyncMock(return_value=None)),
        ):
            try:
                await asyncio.wait_for(rs.run_response_stream_consumer(), timeout=1.0)
            except asyncio.TimeoutError:
                pass

        try:
            await asyncio.sleep(0)
            assert ("s1", "org1") in sweep_called_for
        finally:
            rs._batches = original_batches
            rs._tagging_batches = original_tagging_batches
            rs._pending_tagging.discard("s1")


# ---------------------------------------------------------------------------
# _should_trigger — time threshold
# ---------------------------------------------------------------------------

class TestShouldTriggerTimeThreshold:
    def setup_method(self):
        self._threshold_patcher = patch(
            "crystalos.lib.insight_settings.resolve_stream_response_threshold",
            new=AsyncMock(return_value=10),
        )
        self._threshold_patcher.start()

        import crystalos.consumers.response_stream as rs
        self._orig_time_threshold = rs.TIME_THRESHOLD_MINUTES
        # Pinned explicitly (regression fix, 2026-07-03): this class's assertions
        # are only meaningful relative to a known TIME_THRESHOLD_MINUTES value —
        # previously left to whatever AGENTS_ENV computed at import time, which
        # silently broke test_does_not_trigger_before_time_threshold once the
        # AGENTS_ENV default-threshold bug elsewhere in this module was fixed.
        rs.TIME_THRESHOLD_MINUTES = 5

    def teardown_method(self):
        self._threshold_patcher.stop()
        import crystalos.consumers.response_stream as rs
        rs.TIME_THRESHOLD_MINUTES = self._orig_time_threshold

    @pytest.mark.asyncio
    async def test_triggers_after_time_with_pending_responses(self):
        from crystalos.consumers import response_stream as rs

        original = rs._batches
        rs._batches = _reset_batches()
        try:
            rs._batches["survey-2"]["count"] = 3
            rs._batches["survey-2"]["last_trigger"] = (
                datetime.now(timezone.utc) - timedelta(minutes=6)
            )
            assert await rs._should_trigger("survey-2") is True
        finally:
            rs._batches = original

    @pytest.mark.asyncio
    async def test_does_not_trigger_before_time_threshold(self):
        from crystalos.consumers import response_stream as rs

        original = rs._batches
        rs._batches = _reset_batches()
        try:
            rs._batches["survey-2"]["count"] = 3
            rs._batches["survey-2"]["last_trigger"] = (
                datetime.now(timezone.utc) - timedelta(minutes=2)
            )
            assert await rs._should_trigger("survey-2") is False
        finally:
            rs._batches = original

    @pytest.mark.asyncio
    async def test_does_not_trigger_if_no_pending_responses(self):
        from crystalos.consumers import response_stream as rs

        original = rs._batches
        rs._batches = _reset_batches()
        try:
            rs._batches["survey-2"]["count"] = 0
            rs._batches["survey-2"]["last_trigger"] = (
                datetime.now(timezone.utc) - timedelta(minutes=10)
            )
            assert await rs._should_trigger("survey-2") is False
        finally:
            rs._batches = original

    @pytest.mark.asyncio
    async def test_does_not_trigger_if_no_last_trigger_and_below_count(self):
        from crystalos.consumers import response_stream as rs

        original = rs._batches
        rs._batches = _reset_batches()
        try:
            rs._batches["survey-3"]["count"] = 5
            rs._batches["survey-3"]["last_trigger"] = None
            assert await rs._should_trigger("survey-3") is False
        finally:
            rs._batches = original


# ---------------------------------------------------------------------------
# Batching logic in run_response_stream_consumer
# ---------------------------------------------------------------------------

class TestBatchAccumulation:
    @pytest.mark.asyncio
    async def test_batch_counter_increments_per_event(self):
        from crystalos.consumers import response_stream as rs

        original_batches = rs._batches
        rs._batches = _reset_batches()
        original_tagging_batches = rs._tagging_batches
        rs._tagging_batches = _reset_tagging_batches()

        events = [
            {"survey_id": "s1", "org_id": "org1", "response_id": "r1"},
            {"survey_id": "s1", "org_id": "org1", "response_id": "r2"},
            {"survey_id": "s2", "org_id": "org2", "response_id": "r3"},
        ]

        # Patch consume_events to yield one batch then stop, and _should_trigger to False
        async def fake_consume(**kwargs):
            yield events
            return  # exhausted

        async def fake_should_trigger(survey_id):
            return False

        async def fake_should_trigger_tagging(survey_id):
            return False

        with (
            patch("crystalos.consumers.response_stream.consume_events", fake_consume),
            patch("crystalos.consumers.response_stream._should_trigger", fake_should_trigger),
            patch("crystalos.consumers.response_stream._should_trigger_tagging", fake_should_trigger_tagging),
            patch("crystalos.consumers.response_stream._get_total_response_count", new=AsyncMock(return_value=0)),
            patch("crystalos.consumers.response_stream.should_trigger_progressive_tier", new=AsyncMock(return_value=None)),
        ):
            # run_response_stream_consumer is an infinite loop; we need it to stop
            # after one iteration. The fake_consume above yields once then returns.
            try:
                await asyncio.wait_for(
                    rs.run_response_stream_consumer(), timeout=1.0
                )
            except asyncio.TimeoutError:
                pass  # expected — loop blocks on consume_events

        try:
            assert rs._batches["s1"]["count"] == 2
            assert rs._batches["s1"]["org_id"] == "org1"
            assert rs._batches["s2"]["count"] == 1
            assert rs._batches["s2"]["org_id"] == "org2"
        finally:
            rs._batches = original_batches
            rs._tagging_batches = original_tagging_batches

    @pytest.mark.asyncio
    async def test_trigger_called_when_threshold_reached(self):
        from crystalos.consumers import response_stream as rs

        original_batches = rs._batches
        rs._batches = _reset_batches()
        original_tagging_batches = rs._tagging_batches
        rs._tagging_batches = _reset_tagging_batches()

        # Pre-load a batch at threshold - 1
        rs._batches["s1"]["org_id"] = "org1"
        rs._batches["s1"]["count"] = 9

        # One more event pushes it to 10
        event = {"survey_id": "s1", "org_id": "org1", "response_id": "r10"}

        async def fake_consume(**kwargs):
            yield [event]
            return

        trigger_called_for: list[tuple] = []

        async def fake_trigger(survey_id: str, org_id: str) -> None:
            trigger_called_for.append((survey_id, org_id))

        async def fake_should_trigger_tagging(survey_id):
            return False

        with (
            patch("crystalos.consumers.response_stream.consume_events", fake_consume),
            patch("crystalos.consumers.response_stream._trigger_insights", fake_trigger),
            patch("crystalos.consumers.response_stream._should_trigger_tagging", fake_should_trigger_tagging),
            patch("crystalos.consumers.response_stream._get_survey_status", new=AsyncMock(return_value="active")),
            patch("crystalos.consumers.response_stream._get_total_response_count", new=AsyncMock(return_value=10)),
            patch("crystalos.consumers.response_stream.should_trigger_progressive_tier", new=AsyncMock(return_value=None)),
            # _should_trigger resolves the threshold per survey/org now (2026-07-04)
            # instead of reading a flat module constant — mock it at its source.
            patch("crystalos.lib.insight_settings.resolve_stream_response_threshold", new=AsyncMock(return_value=10)),
        ):
            try:
                await asyncio.wait_for(
                    rs.run_response_stream_consumer(), timeout=1.0
                )
            except asyncio.TimeoutError:
                pass

        try:
            # Give any created tasks a chance to run
            await asyncio.sleep(0)
            assert ("s1", "org1") in trigger_called_for
        finally:
            rs._batches = original_batches
            rs._tagging_batches = original_tagging_batches


# ---------------------------------------------------------------------------
# _redis.consume_events — graceful degradation
# ---------------------------------------------------------------------------

class TestRedisConsumerDegradation:
    @pytest.mark.asyncio
    async def test_consume_events_returns_immediately_if_redis_unavailable(self):
        """If _get_redis() returns None, consume_events should yield nothing."""
        from crystalos.consumers import _redis as redis_mod

        original_redis = redis_mod._redis
        redis_mod._redis = None  # force re-init path

        with patch.object(redis_mod, "_get_redis", new=AsyncMock(return_value=None)):
            collected = []
            async for batch in redis_mod.consume_events(batch_size=10, block_ms=100):
                collected.append(batch)

        redis_mod._redis = original_redis
        assert collected == []


# ---------------------------------------------------------------------------
# Progressive tier system
# ---------------------------------------------------------------------------

class TestProgressiveTierSystem:
    """Tests for should_trigger_progressive_tier and mark_progressive_tier_complete."""

    def _make_mock_redis(self, get_return=None):
        mock_redis = AsyncMock()
        mock_redis.get = AsyncMock(return_value=get_return)
        mock_redis.set = AsyncMock()
        return mock_redis

    @pytest.mark.asyncio
    async def test_triggers_at_first_voices_threshold(self):
        """response_count=10 triggers 'first_voices' when Redis key not set."""
        from crystalos.consumers.response_stream import should_trigger_progressive_tier

        mock_redis = self._make_mock_redis(get_return=None)
        with patch("crystalos.consumers.response_stream._get_redis", new=AsyncMock(return_value=mock_redis)):
            result = await should_trigger_progressive_tier("survey-1", response_count=10)

        assert result == "first_voices"

    @pytest.mark.asyncio
    async def test_triggers_at_early_signals_threshold(self):
        """response_count=40 triggers 'early_signals' (not 'first_voices')."""
        from crystalos.consumers.response_stream import should_trigger_progressive_tier

        mock_redis = self._make_mock_redis(get_return=None)
        with patch("crystalos.consumers.response_stream._get_redis", new=AsyncMock(return_value=mock_redis)):
            result = await should_trigger_progressive_tier("survey-1", response_count=40)

        assert result == "early_signals"

    @pytest.mark.asyncio
    async def test_triggers_at_growing_picture_threshold(self):
        """response_count=70 triggers 'growing_picture'."""
        from crystalos.consumers.response_stream import should_trigger_progressive_tier

        mock_redis = self._make_mock_redis(get_return=None)
        with patch("crystalos.consumers.response_stream._get_redis", new=AsyncMock(return_value=mock_redis)):
            result = await should_trigger_progressive_tier("survey-1", response_count=70)

        assert result == "growing_picture"

    @pytest.mark.asyncio
    async def test_triggers_at_full_report_threshold(self):
        """response_count=100 triggers 'full_report'."""
        from crystalos.consumers.response_stream import should_trigger_progressive_tier

        mock_redis = self._make_mock_redis(get_return=None)
        with patch("crystalos.consumers.response_stream._get_redis", new=AsyncMock(return_value=mock_redis)):
            result = await should_trigger_progressive_tier("survey-1", response_count=100)

        assert result == "full_report"

    @pytest.mark.asyncio
    async def test_does_not_trigger_below_threshold(self):
        """response_count=9 returns None (below all thresholds)."""
        from crystalos.consumers.response_stream import should_trigger_progressive_tier

        mock_redis = self._make_mock_redis(get_return=None)
        with patch("crystalos.consumers.response_stream._get_redis", new=AsyncMock(return_value=mock_redis)):
            result = await should_trigger_progressive_tier("survey-1", response_count=9)

        assert result is None

    @pytest.mark.asyncio
    async def test_dedup_prevents_retrigger(self):
        """Redis key already set ('1') means tier was triggered; returns None."""
        from crystalos.consumers.response_stream import should_trigger_progressive_tier

        mock_redis = self._make_mock_redis(get_return="1")
        with patch("crystalos.consumers.response_stream._get_redis", new=AsyncMock(return_value=mock_redis)):
            result = await should_trigger_progressive_tier("survey-1", response_count=10)

        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_when_redis_unavailable(self):
        """Returns None gracefully when _get_redis() returns None."""
        from crystalos.consumers.response_stream import should_trigger_progressive_tier

        with patch("crystalos.consumers.response_stream._get_redis", new=AsyncMock(return_value=None)):
            result = await should_trigger_progressive_tier("survey-1", response_count=50)

        assert result is None

    @pytest.mark.asyncio
    async def test_mark_tier_complete_sets_redis_key(self):
        """mark_progressive_tier_complete sets the correct Redis key with 30-day TTL."""
        from crystalos.consumers.response_stream import mark_progressive_tier_complete

        mock_redis = AsyncMock()
        mock_redis.set = AsyncMock()

        with patch("crystalos.consumers.response_stream._get_redis", new=AsyncMock(return_value=mock_redis)):
            await mark_progressive_tier_complete("survey-1", "first_voices")

        mock_redis.set.assert_called_once_with(
            "progressive:survey-1:first_voices:triggered",
            "1",
            ex=2592000,
        )

    @pytest.mark.asyncio
    async def test_highest_tier_checked_first(self):
        """response_count=100 with full_report already set returns None (no fallback to lower tiers)."""
        from crystalos.consumers.response_stream import should_trigger_progressive_tier

        async def fake_get(key):
            # full_report is already triggered; growing_picture is not
            if "full_report" in key:
                return "1"
            return None

        mock_redis = AsyncMock()
        mock_redis.get = fake_get

        with patch("crystalos.consumers.response_stream._get_redis", new=AsyncMock(return_value=mock_redis)):
            result = await should_trigger_progressive_tier("survey-1", response_count=100)

        # The highest matching tier (full_report) is already done → None
        assert result is None

    @pytest.mark.asyncio
    async def test_growing_picture_triggers_when_full_report_not_yet_reached(self):
        """response_count=70 with growing_picture not yet triggered fires growing_picture."""
        from crystalos.consumers.response_stream import should_trigger_progressive_tier

        mock_redis = self._make_mock_redis(get_return=None)
        with patch("crystalos.consumers.response_stream._get_redis", new=AsyncMock(return_value=mock_redis)):
            result = await should_trigger_progressive_tier("survey-1", response_count=75)

        assert result == "growing_picture"
