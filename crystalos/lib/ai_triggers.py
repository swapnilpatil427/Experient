"""AI-driven workflow trigger detection (Xperiq Actions Wave 3).

Three signal types, all evaluated once per insight-pipeline run, AFTER the
pipeline has already computed everything they need — this module never
recomputes metrics/topics/sentiment itself, it only reads what
`node_delta_compute` / `node_topics` / `node_metrics` already produced:

  - `sentiment_spike`     — survey-level negative sentiment share jumps well
                            beyond its rolling baseline.
  - `new_theme_detected`  — a topic crosses from "doesn't exist" to
                            "material share of volume" in one checkpoint
                            (reuses `compute_topic_lifecycle`'s `emerged`
                            classification already computed in
                            `node_delta_compute` — this module does not
                            reimplement topic lifecycle math).
  - `anomaly_detected`    — a tracked metric (NPS, response volume) moves
                            further from its rolling baseline than its normal
                            variance would predict (z-score).

Design note — why thresholds AND hysteresis, not just thresholds:
A pure static threshold (e.g. "fire if negative sentiment > 40%") re-fires on
every run for as long as the survey stays elevated, even though nothing NEW
happened between run N and run N+1. That is exactly the "false-positive spam"
TEAM.md's mandate calls out. Hysteresis here means: once a trigger of a given
type has fired for a survey, it will not re-fire for the SAME underlying
condition until either (a) the signal drops back below a lower "reset"
threshold (band hysteresis — prevents chattering around a single threshold
edge), or (b) `cooldown_hours` has elapsed AND the signal is still elevated
(so a sustained problem still re-notifies periodically, just not every run).
This mirrors alarm-system hysteresis (arm/disarm bands), not a debounce timer
alone, because pipeline runs are irregular (stream/schedule/milestone) — a
pure time debounce would double-fire on two closely-spaced stream triggers
and under-fire across a long schedule gap.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

# ── Thresholds ─────────────────────────────────────────────────────────────────
# All are conservative-by-design defaults for a v1 rollout: better to under-fire
# (a missed automation opportunity, recoverable by the user checking the
# dashboard) than to over-fire (an automation that pages someone at 2am for
# noise, which erodes trust in the whole trigger system — TEAM.md's "false
# positive spam" concern is explicitly about this asymmetry). Tune via the AI
# Trigger Sync ritual (TEAM.md) once real firing-rate data exists.

# sentiment_spike — negative-sentiment share (0-100) vs. its own rolling
# baseline (mean of up to the last N checkpoints' negative share).
SENTIMENT_SPIKE_MIN_DELTA_PCT = 15.0     # negative share must rise >= 15pp above baseline to ARM
SENTIMENT_SPIKE_RESET_DELTA_PCT = 8.0    # must fall back below +8pp to DISARM (hysteresis band)
SENTIMENT_SPIKE_MIN_RESPONSES = 15       # minimum new-response volume this run — below this, a "spike" is noise
SENTIMENT_SPIKE_COOLDOWN_HOURS = 12.0    # re-fire at most every N hours while sustained

# new_theme_detected — reuses compute_topic_lifecycle's "emerged" classification
# (>= 3% volume share, per tools/delta.py) but additionally requires the theme's
# average sentiment to be negative — a brand-new POSITIVE theme ("free upgrade
# offer mentioned") is not something a CX team needs paged about; a brand-new
# NEGATIVE theme is exactly the "emerging negative theme" TEAM.md's mandate names.
NEW_THEME_MAX_SENTIMENT = -0.15          # avg_sentiment_score must be <= this to count as "negative"
NEW_THEME_MIN_RESPONSE_COUNT = 5         # minimum mentions — 1-2 verbatims is not yet a "theme"
NEW_THEME_COOLDOWN_HOURS = 24.0          # a theme that keeps "emerging" (flapping in/out of the topic set) re-fires at most daily

# anomaly_detected — z-score of the latest value against the mean/stdev of up
# to the last N checkpoint values for the same metric.
ANOMALY_Z_SCORE_THRESHOLD = 2.0          # ~95% CI for a normal distribution
ANOMALY_RESET_Z_SCORE = 1.0              # must fall back under this to DISARM
ANOMALY_MIN_HISTORY_POINTS = 3           # need at least this many prior points to trust mean/stdev
ANOMALY_COOLDOWN_HOURS = 6.0             # metric anomalies are the most latency-sensitive of the three — shorter cooldown


@dataclass(frozen=True)
class TriggerSignal:
    """One fired AI trigger, ready to become a `workflow_signal` event.
    See docs/automation-hub/WORKFLOW_SIGNAL_CONTRACT.md for the wire shape this feeds."""
    trigger_type: str            # 'sentiment_spike' | 'new_theme_detected' | 'anomaly_detected'
    confidence: float            # 0-1, NOT the same axis as the arm/disarm threshold — see _confidence_from_* below
    severity: str                # 'critical' | 'warning' | 'info'
    summary: str                 # human-readable one-liner
    payload: dict[str, Any] = field(default_factory=dict)  # trigger-specific detail fields


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def _confidence_from_margin(value: float, threshold: float, scale: float) -> float:
    """Map "how far past the threshold" to a 0.5-1.0 confidence band. Exactly at
    threshold => 0.5 (the arm point itself is never more than a coin flip);
    `scale` past it => ~0.88; asymptotes toward 1.0. Never returns < 0.5 for a
    signal that armed at all (callers only call this once armed)."""
    if scale <= 0:
        return 0.5
    margin = max(0.0, value - threshold)
    return _clamp(0.5 + 0.5 * (1 - math.exp(-margin / scale)))


# ── sentiment_spike ────────────────────────────────────────────────────────────

def detect_sentiment_spike(
    current_negative_pct: float,
    baseline_negative_pct: float | None,
    new_response_count: int,
    *,
    was_armed: bool = False,
) -> TriggerSignal | None:
    """Compare current negative-sentiment share against its rolling baseline.

    `baseline_negative_pct=None` means no prior history exists (bootstrap) —
    never fires on the first checkpoint; there is nothing to spike relative to.
    `was_armed` implements the hysteresis reset band: if the trigger already
    fired and is still "armed" from a prior run, the bar to re-report is the
    lower RESET threshold, not the higher ARM threshold, and to fully DISARM
    (return None so the caller resets its armed-state) the delta must drop
    under the reset band.
    """
    if baseline_negative_pct is None:
        return None
    if new_response_count < SENTIMENT_SPIKE_MIN_RESPONSES:
        return None

    delta = current_negative_pct - baseline_negative_pct
    threshold = SENTIMENT_SPIKE_RESET_DELTA_PCT if was_armed else SENTIMENT_SPIKE_MIN_DELTA_PCT
    if delta < threshold:
        return None

    confidence = _confidence_from_margin(delta, SENTIMENT_SPIKE_MIN_DELTA_PCT, scale=15.0)
    severity = "critical" if delta >= SENTIMENT_SPIKE_MIN_DELTA_PCT * 2 else "warning"
    return TriggerSignal(
        trigger_type="sentiment_spike",
        confidence=confidence,
        severity=severity,
        summary=f"Negative sentiment share rose {delta:.1f}pp above baseline ({current_negative_pct:.1f}% vs {baseline_negative_pct:.1f}% baseline).",
        payload={
            "current_negative_pct": round(current_negative_pct, 1),
            "baseline_negative_pct": round(baseline_negative_pct, 1),
            "delta_pct": round(delta, 1),
            "new_response_count": new_response_count,
        },
    )


# ── new_theme_detected ─────────────────────────────────────────────────────────

def detect_new_theme(
    emerged_topics: list[dict],
    topic_signals: dict[str, dict],
) -> list[TriggerSignal]:
    """Given `compute_topic_lifecycle`'s `emerged` list (already computed by
    node_delta_compute — this function does not recompute lifecycle share
    math) and the current run's `topic_signals` (name -> full signal dict from
    `compute_full_topic_signals`), return one TriggerSignal per emerged topic
    that is BOTH materially sized AND net-negative in sentiment.

    A brand-new topic that is neutral/positive is real information (it may be
    worth a dashboard callout) but is not what "detect a new emerging negative
    theme" (the product mandate's own phrasing) asks a workflow trigger to
    page someone about — filtering here, rather than upstream in
    compute_topic_lifecycle, keeps that function's contract (pure share-based
    lifecycle classification) unchanged for its other caller (the narrate
    DELTA_FACTS block, which wants ALL emerged topics regardless of sentiment).
    """
    signals: list[TriggerSignal] = []
    for entry in emerged_topics or []:
        name = entry.get("name") if isinstance(entry, dict) else entry
        if not name:
            continue
        sig = topic_signals.get(name) or {}
        avg_sentiment = sig.get("avg_sentiment_score")
        response_count = sig.get("response_count", 0)
        if avg_sentiment is None or avg_sentiment > NEW_THEME_MAX_SENTIMENT:
            continue
        if response_count < NEW_THEME_MIN_RESPONSE_COUNT:
            continue

        confidence = _confidence_from_margin(-avg_sentiment, -NEW_THEME_MAX_SENTIMENT, scale=0.3)
        severity = "critical" if avg_sentiment <= -0.5 else "warning"
        volume_share = entry.get("volume_share") if isinstance(entry, dict) else None
        signals.append(TriggerSignal(
            trigger_type="new_theme_detected",
            confidence=confidence,
            severity=severity,
            summary=f'New negative theme "{name}" emerged ({response_count} mentions, avg sentiment {avg_sentiment:.2f}).',
            payload={
                "topic_name": name,
                "response_count": response_count,
                "avg_sentiment_score": avg_sentiment,
                "volume_share": volume_share,
            },
        ))
    return signals


# ── anomaly_detected ───────────────────────────────────────────────────────────

def _mean_stdev(values: list[float]) -> tuple[float, float]:
    n = len(values)
    mean = sum(values) / n
    if n < 2:
        return mean, 0.0
    variance = sum((v - mean) ** 2 for v in values) / (n - 1)
    return mean, math.sqrt(variance)


def detect_metric_anomaly(
    metric_name: str,
    current_value: float | None,
    history: list[float],
    *,
    was_armed: bool = False,
) -> TriggerSignal | None:
    """z-score anomaly check for one scalar metric (e.g. NPS) against up to the
    last N checkpoint values (`history`, oldest→newest, current value NOT
    included). Requires >= ANOMALY_MIN_HISTORY_POINTS of history — an early
    survey with 1-2 checkpoints has no meaningful variance estimate, and a
    z-score off a near-zero stdev would explode into false "anomalies" on
    trivial noise.
    """
    if current_value is None or len(history) < ANOMALY_MIN_HISTORY_POINTS:
        return None

    mean, stdev = _mean_stdev(history)
    if stdev == 0:
        return None  # perfectly flat history — any change is meaningful but not a "z-score" anomaly; let meaningful_delta handle it

    z = (current_value - mean) / stdev
    threshold = ANOMALY_RESET_Z_SCORE if was_armed else ANOMALY_Z_SCORE_THRESHOLD
    if abs(z) < threshold:
        return None

    confidence = _confidence_from_margin(abs(z), ANOMALY_Z_SCORE_THRESHOLD, scale=1.5)
    severity = "critical" if abs(z) >= ANOMALY_Z_SCORE_THRESHOLD * 1.5 else "warning"
    direction = "dropped" if z < 0 else "spiked"
    return TriggerSignal(
        trigger_type="anomaly_detected",
        confidence=confidence,
        severity=severity,
        summary=f"{metric_name} {direction} to {current_value:.1f} ({abs(z):.1f} standard deviations from its {len(history)}-checkpoint baseline of {mean:.1f}).",
        payload={
            "metric": metric_name,
            "current_value": round(current_value, 2),
            "baseline_mean": round(mean, 2),
            "baseline_stdev": round(stdev, 2),
            "z_score": round(z, 2),
            "history_points": len(history),
        },
    )


# ── Hysteresis state (Redis-backed, best-effort) ──────────────────────────────
# Armed-state persistence is intentionally NOT load-bearing for correctness —
# Redis being unavailable degrades to "no hysteresis this run" (every armable
# signal is evaluated against its higher ARM threshold, never the lower RESET
# threshold, and cooldown is not enforced) rather than blocking the pipeline or
# silently dropping the signal. This matches the rest of the codebase's
# Redis-optional philosophy (see consumers/_redis.py, lib/memory.py).
import json as _json
import os as _os
import time as _time_mod

_ARMED_STATE_TTL_SECONDS = 7 * 24 * 3600  # 7 days — well past any cooldown window above
_redis_client = None


async def _get_redis_client():
    global _redis_client
    if _redis_client is None:
        try:
            import redis.asyncio as aioredis  # type: ignore[import]
            url = _os.getenv("REDIS_URL", "redis://localhost:6379")
            _redis_client = await aioredis.from_url(url, decode_responses=True)
            await _redis_client.ping()
        except Exception:
            return None
    return _redis_client


async def get_armed_state(key: str) -> dict[str, Any] | None:
    """Return {'armed_at': epoch_seconds, 'last_fired_at': epoch_seconds} for a
    given `K.ai_trigger_armed(...)` key, or None if never armed / Redis down."""
    try:
        client = await _get_redis_client()
        if client is None:
            return None
        raw = await client.get(key)
        return _json.loads(raw) if raw else None
    except Exception:
        return None


async def set_armed_state(key: str, *, fired_at: float | None = None) -> None:
    """Mark a trigger key as armed (fired). Best-effort — never raises."""
    try:
        client = await _get_redis_client()
        if client is None:
            return
        now = fired_at if fired_at is not None else _time_mod.time()
        existing = await get_armed_state(key) or {}
        state = {"armed_at": existing.get("armed_at", now), "last_fired_at": now}
        await client.set(key, _json.dumps(state), ex=_ARMED_STATE_TTL_SECONDS)
    except Exception:
        pass


async def clear_armed_state(key: str) -> None:
    """Disarm a trigger key (signal dropped back under its reset band)."""
    try:
        client = await _get_redis_client()
        if client is None:
            return
        await client.delete(key)
    except Exception:
        pass


def cooldown_elapsed(state: dict[str, Any] | None, cooldown_hours: float) -> bool:
    """True if enough time has passed since `last_fired_at` to re-report a
    STILL-elevated (not yet reset) signal. True when never armed (nothing to
    cool down from) — the caller only reaches this check post-threshold."""
    if not state or not state.get("last_fired_at"):
        return True
    return (_time_mod.time() - float(state["last_fired_at"])) >= cooldown_hours * 3600
