"""OrgSignalDetector — cross-survey org-level anomaly/opportunity detection.

Pure function of an ``org_metrics`` dict already assembled by
``crystalos/graphs/org_brief_graph.py::aggregate_org_metrics`` (no DB I/O of
its own), so it is independently unit-testable — see EVALS.md for the full
18-case table (Addendum 2 of ARCHITECTURE.md).

The 4 signals (ARCHITECTURE.md "Node: detect_org_signals"):
  1. Correlated negative sentiment — >= 3 (sample-size-eligible) surveys
     declining simultaneously.
  2. Response velocity collapse — org velocity < 0.3, was > 0.7 two weeks ago.
  3. NPS floor breach — org avg_nps < -20.
  4. Bright spot — >= 2 surveys improving AND nps_wow_delta > 5.

Custom-range mode (ARCHITECTURE.md Addendum 1): Signal 2 and Signal 3 are
suppressed (with an explicit ``suppressed``/``suppressed_reason`` marker, never
a fabricated number) below a 7-day minimum range floor, since a lookback-based
comparison and a single-point floor check are both statistically unreliable on
a very short custom window.
"""
from __future__ import annotations

from typing import Any

from crystalos.lib.insight_settings import _platform_defaults

from .signal_types import OrgSignal, SignalType

# Mirrors the platform's existing custom_analysis_min_n_for_nps sample-size
# floor (crystalos/lib/insight_settings.py's platform-default constant) rather
# than inventing a new number, per ARCHITECTURE.md Addendum 2's "Sample-size
# floor for correlated org signals."
ORG_SIGNAL_MIN_SAMPLE_SIZE: int = int(_platform_defaults().get("custom_analysis_min_n_for_nps", 30))

CORRELATED_SENTIMENT_MIN_SURVEYS: int = 3
VELOCITY_COLLAPSE_THRESHOLD: float = 0.3
VELOCITY_PRIOR_THRESHOLD: float = 0.7
NPS_FLOOR: float = -20.0
BRIGHT_SPOT_MIN_SURVEYS: int = 2
BRIGHT_SPOT_NPS_DELTA: float = 5.0
CUSTOM_RANGE_SUPPRESSION_FLOOR_DAYS: int = 7


class OrgSignalDetector:
    """Cross-survey org-level signal detection."""

    def detect(self, org_metrics: dict[str, Any]) -> list[OrgSignal]:
        signals: list[OrgSignal] = []
        signals.extend(self._check_correlated_negative_sentiment(org_metrics))
        signals.extend(self._check_velocity_collapse(org_metrics))
        signals.extend(self._check_nps_floor_breach(org_metrics))
        signals.extend(self._check_bright_spot(org_metrics))
        return signals

    # ── shared helpers ───────────────────────────────────────────────────────

    def _all_surveys(self, org_metrics: dict[str, Any]) -> list[dict]:
        return (
            (org_metrics.get("critical_surveys") or [])
            + (org_metrics.get("attention_surveys") or [])
            + (org_metrics.get("healthy_surveys") or [])
        )

    def _eligible_surveys(self, org_metrics: dict[str, Any]) -> list[dict]:
        """Surveys clearing the sample-size floor. Missing/None response_count
        is treated as ineligible — fail closed, never assume a thin survey
        clears the floor."""
        return [
            s for s in self._all_surveys(org_metrics)
            if (s.get("response_count") or 0) >= ORG_SIGNAL_MIN_SAMPLE_SIZE
        ]

    def _is_short_custom_range(self, org_metrics: dict[str, Any]) -> bool:
        return (
            org_metrics.get("period_type") == "custom"
            and (org_metrics.get("range_days") or 0) < CUSTOM_RANGE_SUPPRESSION_FLOOR_DAYS
        )

    def _suppressed_signal(self, signal_type: SignalType, description: str) -> OrgSignal:
        return {
            "signal_type": signal_type.value,
            "severity": "info",
            "title": "Signal suppressed (range too short)",
            "description": description,
            "survey_id": None,
            "suppressed": True,
            "suppressed_reason": "custom_range_below_7_day_floor",
            "metadata": {},
        }

    # ── Signal 1: correlated negative sentiment ─────────────────────────────

    def _check_correlated_negative_sentiment(self, org_metrics: dict[str, Any]) -> list[OrgSignal]:
        eligible = self._eligible_surveys(org_metrics)
        declining = [s for s in eligible if s.get("sentiment_trend") == "declining"]
        if len(declining) < CORRELATED_SENTIMENT_MIN_SURVEYS:
            return []

        total_programs = len(self._all_surveys(org_metrics)) or len(declining)
        tag_sets = [set(s.get("tag_ids") or []) for s in declining]
        common_tags = set.intersection(*tag_sets) if tag_sets else set()
        severity = "critical" if common_tags else "warning"

        return [{
            "signal_type": SignalType.CORRELATED_NEGATIVE_SENTIMENT.value,
            "severity": severity,
            "title": "Correlated negative sentiment",
            "description": (
                f"{len(declining)} of your {total_programs} programs show simultaneous "
                f"negative sentiment this week"
            ),
            "survey_id": None,
            "suppressed": False,
            "suppressed_reason": None,
            "metadata": {
                "survey_ids": [s.get("survey_id") for s in declining],
                "common_tag_ids": sorted(common_tags),
                "total_eligible_programs": total_programs,
            },
        }]

    # ── Signal 2: response velocity collapse ────────────────────────────────

    def _check_velocity_collapse(self, org_metrics: dict[str, Any]) -> list[OrgSignal]:
        if self._is_short_custom_range(org_metrics):
            return [self._suppressed_signal(
                SignalType.VELOCITY_COLLAPSE,
                "Response volume dropped 60%+ compared to last week",
            )]

        history = org_metrics.get("weekly_history") or []
        if len(history) < 3:
            return []
        current = history[-1]
        two_weeks_ago = history[-3]
        current_v = current.get("org_response_velocity")
        prior_v = two_weeks_ago.get("org_response_velocity")
        if current_v is None or prior_v is None:
            return []
        if current_v < VELOCITY_COLLAPSE_THRESHOLD and prior_v > VELOCITY_PRIOR_THRESHOLD:
            return [{
                "signal_type": SignalType.VELOCITY_COLLAPSE.value,
                "severity": "warning",
                "title": "Response velocity collapse",
                "description": "Response volume dropped 60%+ compared to last week",
                "survey_id": None,
                "suppressed": False,
                "suppressed_reason": None,
                "metadata": {
                    "current_velocity": current_v,
                    "velocity_two_weeks_ago": prior_v,
                    "current_week_start": current.get("week_start"),
                },
            }]
        return []

    # ── Signal 3: NPS floor breach ───────────────────────────────────────────

    def _check_nps_floor_breach(self, org_metrics: dict[str, Any]) -> list[OrgSignal]:
        if self._is_short_custom_range(org_metrics):
            return [self._suppressed_signal(
                SignalType.NPS_FLOOR_BREACH,
                "Org-level NPS has fallen below -20 — immediate review recommended",
            )]

        avg_nps = org_metrics.get("avg_nps")
        if avg_nps is None or avg_nps >= NPS_FLOOR:
            return []
        return [{
            "signal_type": SignalType.NPS_FLOOR_BREACH.value,
            "severity": "critical",
            "title": "NPS floor breach",
            "description": "Org-level NPS has fallen below -20 — immediate review recommended",
            "survey_id": None,
            "suppressed": False,
            "suppressed_reason": None,
            "metadata": {"avg_nps": avg_nps},
        }]

    # ── Signal 4: bright spot ────────────────────────────────────────────────

    def _check_bright_spot(self, org_metrics: dict[str, Any]) -> list[OrgSignal]:
        eligible = self._eligible_surveys(org_metrics)
        improving = [s for s in eligible if s.get("sentiment_trend") == "improving"]
        nps_wow_delta = org_metrics.get("nps_wow_delta")
        if (
            len(improving) < BRIGHT_SPOT_MIN_SURVEYS
            or nps_wow_delta is None
            or nps_wow_delta <= BRIGHT_SPOT_NPS_DELTA
        ):
            return []
        return [{
            "signal_type": SignalType.BRIGHT_SPOT.value,
            "severity": "info",
            "title": "Bright spot",
            "description": "Multiple programs are trending positive — worth amplifying",
            "survey_id": None,
            "suppressed": False,
            "suppressed_reason": None,
            "metadata": {
                "survey_ids": [s.get("survey_id") for s in improving],
                "nps_wow_delta": nps_wow_delta,
            },
        }]
