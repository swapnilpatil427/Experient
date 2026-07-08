"""Tests for graphs/insights.py's node_ai_triggers (Xperiq Actions Wave 3) and
its _aggregate_negative_pct helper.

node_ai_triggers reads already-computed pipeline state (delta_from_prior,
topic_signals, metrics, prior_checkpoint_summaries) and calls out to
lib.ai_triggers (detection) + lib.workflow_signal_client (delivery) — both are
mocked here per crystalos/CLAUDE.md testing rules (no real Redis, no real
HTTP calls). Uses tests.test_pipeline's `_make_state` helper for a minimal
valid InsightState dict.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from crystalos.graphs.insights import node_ai_triggers, _aggregate_negative_pct
from tests.test_pipeline import _make_state


def _patched(**overrides):
    """Context manager bundle: patches get_armed_state/set_armed_state/clear_armed_state
    (all no-op/None by default — 'never armed before') and emit_workflow_signal
    (records calls, returns True)."""
    defaults = dict(
        get_armed_state=AsyncMock(return_value=None),
        set_armed_state=AsyncMock(return_value=None),
        clear_armed_state=AsyncMock(return_value=None),
        emit_workflow_signal=AsyncMock(return_value=True),
    )
    defaults.update(overrides)
    return defaults


class TestAggregateNegativePct:
    def test_no_topics_returns_none(self):
        assert _aggregate_negative_pct({}) is None

    def test_single_topic_returns_its_pct(self):
        signals = {"Billing": {"response_count": 10, "sentiment_negative_pct": 40.0}}
        assert _aggregate_negative_pct(signals) == pytest.approx(40.0)

    def test_weighted_average_across_topics(self):
        signals = {
            "Billing": {"response_count": 10, "sentiment_negative_pct": 80.0},
            "Shipping": {"response_count": 30, "sentiment_negative_pct": 20.0},
        }
        # weighted: (10*80 + 30*20) / 40 = (800+600)/40 = 35.0
        assert _aggregate_negative_pct(signals) == pytest.approx(35.0)

    def test_topics_with_zero_responses_are_skipped(self):
        signals = {
            "Empty": {"response_count": 0, "sentiment_negative_pct": 100.0},
            "Real": {"response_count": 10, "sentiment_negative_pct": 20.0},
        }
        assert _aggregate_negative_pct(signals) == pytest.approx(20.0)


@pytest.mark.asyncio
class TestNodeAiTriggers:
    async def test_skips_when_skip_run(self):
        state = _make_state(skip_run=True)
        with patch("crystalos.lib.workflow_signal_client.emit_workflow_signal", new=AsyncMock()) as mock_emit:
            result = await node_ai_triggers(state)
        assert result == state
        mock_emit.assert_not_called()

    async def test_skips_when_skipped_checkpoint(self):
        state = _make_state(skipped_checkpoint=True)
        with patch("crystalos.lib.workflow_signal_client.emit_workflow_signal", new=AsyncMock()) as mock_emit:
            result = await node_ai_triggers(state)
        mock_emit.assert_not_called()

    async def test_skips_for_manual_profile(self):
        from crystalos.lib.constants import INSIGHT_PROFILE_MANUAL_EXPERT
        state = _make_state(profile=INSIGHT_PROFILE_MANUAL_EXPERT)
        with patch("crystalos.lib.workflow_signal_client.emit_workflow_signal", new=AsyncMock()) as mock_emit:
            result = await node_ai_triggers(state)
        mock_emit.assert_not_called()

    async def test_no_signals_fire_when_nothing_anomalous(self):
        state = _make_state(
            profile="automated_incremental",
            topic_signals={"Billing": {"response_count": 30, "sentiment_negative_pct": 15.0, "avg_sentiment_score": 0.1}},
            metrics={"nps": {"score": 41.0}},
            delta_from_prior={"topic_changes": {"emerged": []}},
            ai_trigger_baseline_negative_pct=14.0,
            prior_checkpoint_summaries=[{"nps": 40.0}, {"nps": 41.0}, {"nps": 39.0}],
            new_response_ids={"r1"},
        )
        patches = _patched()
        with patch("crystalos.lib.ai_triggers.get_armed_state", patches["get_armed_state"]), \
             patch("crystalos.lib.ai_triggers.set_armed_state", patches["set_armed_state"]), \
             patch("crystalos.lib.ai_triggers.clear_armed_state", patches["clear_armed_state"]), \
             patch("crystalos.lib.workflow_signal_client.emit_workflow_signal", patches["emit_workflow_signal"]):
            await node_ai_triggers(state)
        patches["emit_workflow_signal"].assert_not_called()

    async def test_sentiment_spike_fires_and_emits_signal(self):
        state = _make_state(
            profile="automated_incremental",
            topic_signals={"Billing": {"response_count": 30, "sentiment_negative_pct": 60.0, "avg_sentiment_score": -0.5}},
            metrics={"nps": {"score": 40.0}},
            delta_from_prior={"topic_changes": {"emerged": []}},
            ai_trigger_baseline_negative_pct=15.0,
            prior_checkpoint_summaries=[{"nps": 40.0}, {"nps": 41.0}, {"nps": 39.0}],
            new_response_ids={"r1", "r2"} | {f"r{i}" for i in range(20)},
        )
        patches = _patched()
        with patch("crystalos.lib.ai_triggers.get_armed_state", patches["get_armed_state"]), \
             patch("crystalos.lib.ai_triggers.set_armed_state", patches["set_armed_state"]), \
             patch("crystalos.lib.ai_triggers.clear_armed_state", patches["clear_armed_state"]), \
             patch("crystalos.lib.workflow_signal_client.emit_workflow_signal", patches["emit_workflow_signal"]):
            await node_ai_triggers(state)

        patches["emit_workflow_signal"].assert_awaited_once()
        call_kwargs = patches["emit_workflow_signal"].call_args.kwargs
        assert call_kwargs["signal_type"] == "sentiment_spike"
        assert call_kwargs["org_id"] == state["org_id"]
        assert call_kwargs["survey_id"] == state["survey_id"]
        patches["set_armed_state"].assert_awaited()

    async def test_new_negative_theme_fires_and_emits_signal(self):
        state = _make_state(
            profile="automated_incremental",
            topic_signals={
                "Billing errors": {"response_count": 15, "sentiment_negative_pct": 30.0, "avg_sentiment_score": -0.5},
            },
            metrics={"nps": {"score": 40.0}},
            delta_from_prior={"topic_changes": {"emerged": [{"name": "Billing errors", "volume_share": 0.08}]}},
            ai_trigger_baseline_negative_pct=None,
            prior_checkpoint_summaries=[],
        )
        patches = _patched()
        with patch("crystalos.lib.ai_triggers.get_armed_state", patches["get_armed_state"]), \
             patch("crystalos.lib.ai_triggers.set_armed_state", patches["set_armed_state"]), \
             patch("crystalos.lib.ai_triggers.clear_armed_state", patches["clear_armed_state"]), \
             patch("crystalos.lib.workflow_signal_client.emit_workflow_signal", patches["emit_workflow_signal"]):
            await node_ai_triggers(state)

        patches["emit_workflow_signal"].assert_awaited_once()
        call_kwargs = patches["emit_workflow_signal"].call_args.kwargs
        assert call_kwargs["signal_type"] == "new_theme_detected"
        assert call_kwargs["payload"]["topic_name"] == "Billing errors"

    async def test_nps_anomaly_fires_and_emits_signal(self):
        state = _make_state(
            profile="automated_incremental",
            topic_signals={},
            metrics={"nps": {"score": 5.0}},
            delta_from_prior={"topic_changes": {"emerged": []}},
            ai_trigger_baseline_negative_pct=None,
            prior_checkpoint_summaries=[{"nps": 40.0}, {"nps": 41.0}, {"nps": 39.0}, {"nps": 40.0}],
        )
        patches = _patched()
        with patch("crystalos.lib.ai_triggers.get_armed_state", patches["get_armed_state"]), \
             patch("crystalos.lib.ai_triggers.set_armed_state", patches["set_armed_state"]), \
             patch("crystalos.lib.ai_triggers.clear_armed_state", patches["clear_armed_state"]), \
             patch("crystalos.lib.workflow_signal_client.emit_workflow_signal", patches["emit_workflow_signal"]):
            await node_ai_triggers(state)

        patches["emit_workflow_signal"].assert_awaited_once()
        call_kwargs = patches["emit_workflow_signal"].call_args.kwargs
        assert call_kwargs["signal_type"] == "anomaly_detected"
        assert call_kwargs["payload"]["metric"] == "NPS"

    async def test_multiple_signals_each_emitted_separately(self):
        """A single run can fire more than one signal type — each is delivered
        as its own call, not batched (WORKFLOW_SIGNAL_CONTRACT.md §6.2 item 3)."""
        state = _make_state(
            profile="automated_incremental",
            topic_signals={
                "Billing errors": {"response_count": 40, "sentiment_negative_pct": 60.0, "avg_sentiment_score": -0.5},
            },
            metrics={"nps": {"score": 5.0}},
            delta_from_prior={"topic_changes": {"emerged": [{"name": "Billing errors", "volume_share": 0.08}]}},
            ai_trigger_baseline_negative_pct=15.0,
            prior_checkpoint_summaries=[{"nps": 40.0}, {"nps": 41.0}, {"nps": 39.0}],
            new_response_ids={f"r{i}" for i in range(20)},
        )
        patches = _patched()
        with patch("crystalos.lib.ai_triggers.get_armed_state", patches["get_armed_state"]), \
             patch("crystalos.lib.ai_triggers.set_armed_state", patches["set_armed_state"]), \
             patch("crystalos.lib.ai_triggers.clear_armed_state", patches["clear_armed_state"]), \
             patch("crystalos.lib.workflow_signal_client.emit_workflow_signal", patches["emit_workflow_signal"]):
            await node_ai_triggers(state)

        assert patches["emit_workflow_signal"].await_count == 3
        fired_types = {c.kwargs["signal_type"] for c in patches["emit_workflow_signal"].await_args_list}
        assert fired_types == {"sentiment_spike", "new_theme_detected", "anomaly_detected"}

    async def test_never_raises_on_internal_error(self):
        state = _make_state(profile="automated_incremental", topic_signals={}, metrics={})
        with patch("crystalos.lib.ai_triggers.get_armed_state", new=AsyncMock(side_effect=RuntimeError("boom"))):
            result = await node_ai_triggers(state)  # must not raise
        assert result is state

    async def test_already_armed_signal_still_below_threshold_disarms(self):
        """A sentiment_spike that was armed but has now dropped back under the
        RESET band should clear its armed-state (disarm) rather than staying
        stuck 'armed' forever."""
        state = _make_state(
            profile="automated_incremental",
            topic_signals={"Billing": {"response_count": 30, "sentiment_negative_pct": 16.0, "avg_sentiment_score": 0.0}},
            metrics={"nps": {"score": 40.0}},
            delta_from_prior={"topic_changes": {"emerged": []}},
            ai_trigger_baseline_negative_pct=15.0,
            prior_checkpoint_summaries=[{"nps": 40.0}, {"nps": 41.0}, {"nps": 39.0}],
            new_response_ids={f"r{i}" for i in range(20)},
        )
        patches = _patched(get_armed_state=AsyncMock(return_value={"armed_at": 1.0, "last_fired_at": 1.0}))
        with patch("crystalos.lib.ai_triggers.get_armed_state", patches["get_armed_state"]), \
             patch("crystalos.lib.ai_triggers.set_armed_state", patches["set_armed_state"]), \
             patch("crystalos.lib.ai_triggers.clear_armed_state", patches["clear_armed_state"]), \
             patch("crystalos.lib.workflow_signal_client.emit_workflow_signal", patches["emit_workflow_signal"]):
            await node_ai_triggers(state)

        patches["emit_workflow_signal"].assert_not_called()
        patches["clear_armed_state"].assert_awaited()
