"""Shared types for the org_signal_detector skill.

See docs/org-dashboard/ARCHITECTURE.md "Node: detect_org_signals" and
"Addendum 1: org_brief_graph.py changes for custom ranges" for the 4-signal
spec and the custom-range suppression rule.
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Literal, TypedDict


class SignalType(str, Enum):
    CORRELATED_NEGATIVE_SENTIMENT = "correlated_negative_sentiment"
    VELOCITY_COLLAPSE = "velocity_collapse"
    NPS_FLOOR_BREACH = "nps_floor_breach"
    BRIGHT_SPOT = "bright_spot"


class OrgSignal(TypedDict, total=False):
    signal_type: str                              # SignalType value
    severity: Literal["critical", "warning", "info"]
    title: str
    description: str
    # The specific survey the signal centers on, or None for a genuinely
    # org-wide signal — mirrors alert_events.survey_id's nullable semantics
    # (ARCHITECTURE.md / IMPLEMENTATION_SPEC.md Decision 23).
    survey_id: str | None
    # True when this signal's check was skipped for a range too short to be
    # statistically meaningful (custom mode, < CUSTOM_RANGE_SUPPRESSION_FLOOR_DAYS)
    # — an explicit marker, never a fabricated number (ARCHITECTURE.md Addendum 1).
    suppressed: bool
    suppressed_reason: str | None
    metadata: dict[str, Any]
