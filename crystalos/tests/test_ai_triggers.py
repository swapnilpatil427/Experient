"""Tests for lib/ai_triggers.py — AI-driven workflow trigger detection
(sentiment_spike, new_theme_detected, anomaly_detected) and Redis-backed
hysteresis (Xperiq Actions Wave 3).

Synthetic-data fixtures per crystalos/CLAUDE.md testing rules — no LLM calls
(this module is pure Python, no LLM involved at all) and Redis is mocked via
AsyncMock so these tests never require a live Redis instance.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from crystalos.lib import ai_triggers as at


# ── sentiment_spike ────────────────────────────────────────────────────────────

class TestDetectSentimentSpike:
    def test_no_baseline_never_fires(self):
        """Bootstrap (no prior checkpoint) — nothing to spike relative to."""
        result = at.detect_sentiment_spike(current_negative_pct=80.0, baseline_negative_pct=None, new_response_count=50)
        assert result is None

    def test_below_min_response_count_never_fires(self):
        result = at.detect_sentiment_spike(current_negative_pct=90.0, baseline_negative_pct=10.0, new_response_count=3)
        assert result is None

    def test_delta_below_threshold_does_not_fire(self):
        result = at.detect_sentiment_spike(current_negative_pct=20.0, baseline_negative_pct=15.0, new_response_count=50)
        assert result is None

    def test_delta_at_or_above_threshold_fires(self):
        result = at.detect_sentiment_spike(current_negative_pct=35.0, baseline_negative_pct=15.0, new_response_count=50)
        assert result is not None
        assert result.trigger_type == "sentiment_spike"
        assert 0.5 <= result.confidence <= 1.0
        assert result.payload["delta_pct"] == pytest.approx(20.0)

    def test_very_large_delta_is_critical_severity(self):
        result = at.detect_sentiment_spike(current_negative_pct=80.0, baseline_negative_pct=10.0, new_response_count=50)
        assert result.severity == "critical"

    def test_moderate_delta_is_warning_severity(self):
        result = at.detect_sentiment_spike(current_negative_pct=32.0, baseline_negative_pct=15.0, new_response_count=50)
        assert result.severity == "warning"

    def test_hysteresis_reset_band_lower_than_arm_band(self):
        """Once armed, re-firing needs only the lower RESET delta, not the full ARM delta."""
        # delta=10: below ARM threshold (15) but above RESET threshold (8) -> fires only if was_armed=True.
        not_armed = at.detect_sentiment_spike(current_negative_pct=25.0, baseline_negative_pct=15.0, new_response_count=50, was_armed=False)
        already_armed = at.detect_sentiment_spike(current_negative_pct=25.0, baseline_negative_pct=15.0, new_response_count=50, was_armed=True)
        assert not_armed is None
        assert already_armed is not None


# ── new_theme_detected ─────────────────────────────────────────────────────────

class TestDetectNewTheme:
    def test_no_emerged_topics_returns_empty(self):
        assert at.detect_new_theme([], {}) == []

    def test_positive_new_topic_is_filtered_out(self):
        emerged = [{"name": "Free upgrade offer", "volume_share": 0.05}]
        topic_signals = {"Free upgrade offer": {"avg_sentiment_score": 0.6, "response_count": 20}}
        assert at.detect_new_theme(emerged, topic_signals) == []

    def test_negative_new_topic_with_enough_volume_fires(self):
        emerged = [{"name": "Billing errors", "volume_share": 0.08}]
        topic_signals = {"Billing errors": {"avg_sentiment_score": -0.4, "response_count": 12}}
        signals = at.detect_new_theme(emerged, topic_signals)
        assert len(signals) == 1
        assert signals[0].trigger_type == "new_theme_detected"
        assert signals[0].payload["topic_name"] == "Billing errors"

    def test_negative_but_too_few_mentions_does_not_fire(self):
        emerged = [{"name": "Rare complaint", "volume_share": 0.03}]
        topic_signals = {"Rare complaint": {"avg_sentiment_score": -0.8, "response_count": 2}}
        assert at.detect_new_theme(emerged, topic_signals) == []

    def test_missing_topic_signal_does_not_fire(self):
        """emerged references a topic with no matching signal entry — degrade gracefully."""
        emerged = [{"name": "Unknown topic"}]
        assert at.detect_new_theme(emerged, {}) == []

    def test_multiple_emerged_topics_each_evaluated_independently(self):
        emerged = [
            {"name": "Billing errors", "volume_share": 0.08},
            {"name": "Great new feature", "volume_share": 0.05},
            {"name": "Shipping delays", "volume_share": 0.06},
        ]
        topic_signals = {
            "Billing errors": {"avg_sentiment_score": -0.5, "response_count": 15},
            "Great new feature": {"avg_sentiment_score": 0.7, "response_count": 15},
            "Shipping delays": {"avg_sentiment_score": -0.3, "response_count": 10},
        }
        signals = at.detect_new_theme(emerged, topic_signals)
        names = {s.payload["topic_name"] for s in signals}
        assert names == {"Billing errors", "Shipping delays"}

    def test_very_negative_theme_is_critical(self):
        emerged = [{"name": "Fraud complaint", "volume_share": 0.1}]
        topic_signals = {"Fraud complaint": {"avg_sentiment_score": -0.9, "response_count": 20}}
        signals = at.detect_new_theme(emerged, topic_signals)
        assert signals[0].severity == "critical"

    def test_accepts_plain_string_entries_not_just_dicts(self):
        """compute_topic_lifecycle's other callers sometimes pass plain name
        strings (Phase 0.5 shape) — must not crash."""
        emerged = ["Billing errors"]
        topic_signals = {"Billing errors": {"avg_sentiment_score": -0.5, "response_count": 15}}
        signals = at.detect_new_theme(emerged, topic_signals)
        assert len(signals) == 1


# ── anomaly_detected ───────────────────────────────────────────────────────────

class TestDetectMetricAnomaly:
    def test_insufficient_history_never_fires(self):
        result = at.detect_metric_anomaly("NPS", current_value=10.0, history=[40.0, 42.0])
        assert result is None

    def test_missing_current_value_never_fires(self):
        result = at.detect_metric_anomaly("NPS", current_value=None, history=[40.0, 42.0, 41.0])
        assert result is None

    def test_flat_history_zero_stdev_never_fires(self):
        result = at.detect_metric_anomaly("NPS", current_value=50.0, history=[40.0, 40.0, 40.0])
        assert result is None

    def test_value_within_normal_range_does_not_fire(self):
        result = at.detect_metric_anomaly("NPS", current_value=42.0, history=[38.0, 40.0, 42.0, 44.0, 40.0])
        assert result is None

    def test_large_drop_fires_with_negative_z(self):
        history = [40.0, 42.0, 41.0, 39.0, 40.0]  # mean=40.4, stdev~1.14
        result = at.detect_metric_anomaly("NPS", current_value=10.0, history=history)
        assert result is not None
        assert result.payload["z_score"] < 0
        assert "dropped" in result.summary

    def test_large_rise_fires_with_positive_z(self):
        history = [40.0, 42.0, 41.0, 39.0, 40.0]
        result = at.detect_metric_anomaly("NPS", current_value=70.0, history=history)
        assert result is not None
        assert result.payload["z_score"] > 0
        assert "spiked" in result.summary

    def test_hysteresis_reset_z_lower_than_arm_z(self):
        history = [40.0, 42.0, 41.0, 39.0, 40.0]
        # A z-score that clears RESET (1.0) but not ARM (2.0)
        mean, stdev = at._mean_stdev(history)
        borderline_value = mean + stdev * 1.5
        not_armed = at.detect_metric_anomaly("NPS", borderline_value, history, was_armed=False)
        already_armed = at.detect_metric_anomaly("NPS", borderline_value, history, was_armed=True)
        assert not_armed is None
        assert already_armed is not None


# ── Hysteresis state persistence (Redis-backed, best-effort) ──────────────────

class TestHysteresisState:
    @pytest.mark.asyncio
    async def test_get_armed_state_returns_none_when_redis_unavailable(self):
        with patch("crystalos.lib.ai_triggers._get_redis_client", new=AsyncMock(return_value=None)):
            result = await at.get_armed_state("some-key")
        assert result is None

    @pytest.mark.asyncio
    async def test_set_and_get_armed_state_roundtrip(self):
        store: dict[str, str] = {}

        class FakeRedis:
            async def get(self, key):
                return store.get(key)

            async def set(self, key, value, ex=None):
                store[key] = value

            async def delete(self, key):
                store.pop(key, None)

        fake = FakeRedis()
        with patch("crystalos.lib.ai_triggers._get_redis_client", new=AsyncMock(return_value=fake)):
            await at.set_armed_state("k1", fired_at=1000.0)
            state = await at.get_armed_state("k1")
        assert state is not None
        assert state["last_fired_at"] == 1000.0
        assert state["armed_at"] == 1000.0

    @pytest.mark.asyncio
    async def test_clear_armed_state_removes_key(self):
        store = {"k1": '{"armed_at": 1.0, "last_fired_at": 1.0}'}

        class FakeRedis:
            async def get(self, key):
                return store.get(key)

            async def delete(self, key):
                store.pop(key, None)

        fake = FakeRedis()
        with patch("crystalos.lib.ai_triggers._get_redis_client", new=AsyncMock(return_value=fake)):
            await at.clear_armed_state("k1")
        assert "k1" not in store

    def test_cooldown_elapsed_true_when_never_armed(self):
        assert at.cooldown_elapsed(None, cooldown_hours=12.0) is True

    def test_cooldown_elapsed_false_within_window(self):
        import time
        state = {"last_fired_at": time.time() - 60}  # fired 1 minute ago
        assert at.cooldown_elapsed(state, cooldown_hours=12.0) is False

    def test_cooldown_elapsed_true_after_window(self):
        import time
        state = {"last_fired_at": time.time() - 13 * 3600}  # fired 13 hours ago
        assert at.cooldown_elapsed(state, cooldown_hours=12.0) is True

    @pytest.mark.asyncio
    async def test_redis_exception_degrades_to_none_not_raise(self):
        async def _boom():
            raise ConnectionError("redis down")

        with patch("crystalos.lib.ai_triggers._get_redis_client", new=AsyncMock(side_effect=ConnectionError("down"))):
            result = await at.get_armed_state("k1")
        assert result is None
        with patch("crystalos.lib.ai_triggers._get_redis_client", new=AsyncMock(side_effect=ConnectionError("down"))):
            await at.set_armed_state("k1")  # must not raise
            await at.clear_armed_state("k1")  # must not raise


class TestRedisKeyBuilder:
    def test_ai_trigger_armed_key_shape(self):
        from crystalos.lib.redis_keys import K
        key = K.ai_trigger_armed(None, "survey-1", "sentiment_spike")
        assert key == "global:ai_trigger_armed:survey-1:sentiment_spike:_"

    def test_ai_trigger_armed_key_with_signal_key_disambiguates(self):
        from crystalos.lib.redis_keys import K
        key1 = K.ai_trigger_armed(None, "survey-1", "new_theme_detected", "Billing errors")
        key2 = K.ai_trigger_armed(None, "survey-1", "new_theme_detected", "Shipping delays")
        assert key1 != key2

    def test_ai_trigger_armed_key_namespaced_by_brand(self):
        from crystalos.lib.redis_keys import K
        key = K.ai_trigger_armed("brand-x", "survey-1", "anomaly_detected", "nps")
        assert key.startswith("brand:brand-x:")
