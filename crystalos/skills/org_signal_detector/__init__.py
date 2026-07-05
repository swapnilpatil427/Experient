"""org_signal_detector — cross-survey org-level signal detection skill.

See SKILL.md for the full skill contract and EVALS.md for the labeled test
case table. ``detector.OrgSignalDetector`` is the pure-function entry point
consumed by ``crystalos/graphs/org_brief_graph.py``'s ``detect_org_signals`` node.
"""
from __future__ import annotations

from .detector import OrgSignalDetector
from .signal_types import OrgSignal, SignalType

__all__ = ["OrgSignalDetector", "OrgSignal", "SignalType"]
