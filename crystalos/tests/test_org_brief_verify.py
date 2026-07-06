"""Unit tests for crystalos/lib/org_brief_verify.py — the post-publish
verification & lineage step for Org Brief (Command Center).

Covers two production-readiness-audit fixes (see
docs/org-dashboard/PRODUCTION_READINESS_AUDIT.md):

  - Fix 2 (belt-and-suspenders): an empty/whitespace-only narrative passed to
    verify_and_score must immediately return verdict "fail" with the
    "empty_or_missing_narrative" issue, without attempting the normal
    numeric-grounding pass (score_insight is never even called).
  - Fix 3 (fail-closed pass 3): if pass 3's LLM-judge call itself throws, the
    exception handler must NOT silently return [] (which reads identically to
    "checked, found nothing wrong") — it must return a distinguishable
    sentinel finding that degrades verify_and_score's overall verdict to
    "flag", matching pass 1/2's own fail-closed convention.

Mocking conventions follow crystalos/tests/test_tag_report.py: `db._pool_conn()`
is mocked with an async-context-manager-shaped MagicMock/AsyncMock chain, and
LLM calls (`call_agent`, `score_insight`) are patched directly — no real
DB/network calls, per crystalos/CLAUDE.md's testing conventions.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from crystalos.lib.hallucination_scorer import HallucinationScore
from crystalos.lib.org_brief_verify import _grounding_completeness_check, verify_and_score


def _make_pool():
    """A db._pool_conn()-shaped mock whose UPDATE/commit calls are no-ops."""
    mock_conn = AsyncMock()
    mock_conn.execute = AsyncMock()
    mock_conn.commit = AsyncMock()
    mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_conn.__aexit__ = AsyncMock(return_value=False)

    pool_ctx = MagicMock()
    pool_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
    pool_ctx.__aexit__ = AsyncMock(return_value=False)

    mock_pool = MagicMock()
    mock_pool.connection = MagicMock(return_value=pool_ctx)
    return mock_pool, mock_conn


# ── Fix 2: empty/whitespace-only narrative fails closed, skips the normal pass ──

@pytest.mark.parametrize("narrative", ["", "   ", "\n\t  "])
async def test_verify_and_score_empty_narrative_fails_without_scoring(narrative):
    mock_pool, mock_conn = _make_pool()
    with (
        patch("crystalos.lib.org_brief_verify.db._pool_conn", return_value=mock_pool),
        patch("crystalos.lib.org_brief_verify.score_insight", AsyncMock()) as mock_score_insight,
        patch(
            "crystalos.lib.org_brief_verify._grounding_completeness_check", AsyncMock(),
        ) as mock_pass3,
    ):
        score, verdict, trust_json = await verify_and_score(
            brief_id="brief-1",
            narrative=narrative,
            recommendations=[],
            input_snapshot={"avg_nps": 10.0},
            org_signals=[],
            table="org_crystal_briefs",
        )

    assert verdict == "fail"
    assert score == 0.0
    assert trust_json["pass_1_2_numeric_and_llm_grounding"]["issues"] == ["empty_or_missing_narrative"]
    assert trust_json["pass_1_2_numeric_and_llm_grounding"]["verdict"] == "fail"
    # The normal numeric-grounding pass (and pass 3) must never even run.
    mock_score_insight.assert_not_called()
    mock_pass3.assert_not_called()
    # The row is still written (UPDATE hallucination_score/trust_json), just
    # with the fail-closed result — never silently skipped.
    mock_conn.execute.assert_called_once()


async def test_verify_and_score_non_empty_narrative_runs_normal_pass():
    """Sanity check: a real narrative still goes through the normal 3-pass flow
    (guards against a too-broad empty check swallowing legitimate input)."""
    mock_pool, mock_conn = _make_pool()
    passing_score = HallucinationScore(
        score=0.95, verdict="pass", issues=[], deterministic_score=0.95, llm_score=None,
    )
    with (
        patch("crystalos.lib.org_brief_verify.db._pool_conn", return_value=mock_pool),
        patch(
            "crystalos.lib.org_brief_verify.score_insight", AsyncMock(return_value=passing_score),
        ) as mock_score_insight,
        patch(
            "crystalos.lib.org_brief_verify._grounding_completeness_check",
            AsyncMock(return_value=[]),
        ),
    ):
        score, verdict, trust_json = await verify_and_score(
            brief_id="brief-2",
            narrative="Org NPS is 10.0 this week.",
            recommendations=[],
            input_snapshot={"avg_nps": 10.0},
            org_signals=[],
            table="org_crystal_briefs",
        )

    mock_score_insight.assert_called_once()
    assert verdict == "pass"
    assert score == 0.95


# ── Fix 3: pass 3's exception handler fails closed, not silently clean ─────────

async def test_grounding_completeness_check_exception_returns_sentinel_not_empty():
    with patch(
        "crystalos.lib.openrouter.call_agent", AsyncMock(side_effect=RuntimeError("LLM timeout")),
    ):
        failures = await _grounding_completeness_check(
            narrative="NPS dropped because of the pricing change.",
            org_signals=[],
            input_snapshot={},
            cited_insights=[],
        )

    assert failures != []
    assert failures == [{
        "clause": "<verification unavailable>",
        "reason": "grounding_completeness_check_failed_to_run",
    }]


async def test_verify_and_score_degrades_to_flag_when_pass3_fails_to_run():
    """End-to-end: pass 1/2 passes cleanly, but pass 3's LLM call throws — the
    overall verdict must degrade from 'pass' to 'flag', not stay 'pass'."""
    mock_pool, mock_conn = _make_pool()
    passing_score = HallucinationScore(
        score=0.95, verdict="pass", issues=[], deterministic_score=0.95, llm_score=None,
    )
    with (
        patch("crystalos.lib.org_brief_verify.db._pool_conn", return_value=mock_pool),
        patch("crystalos.lib.org_brief_verify.score_insight", AsyncMock(return_value=passing_score)),
        patch("crystalos.lib.org_brief_verify._fetch_cited_insights", AsyncMock(return_value=[])),
        patch(
            "crystalos.lib.openrouter.call_agent",
            AsyncMock(side_effect=RuntimeError("LLM timeout")),
        ),
    ):
        score, verdict, trust_json = await verify_and_score(
            brief_id="brief-3",
            narrative="NPS dropped because of the pricing change.",
            recommendations=[],
            input_snapshot={},
            org_signals=[],
            table="org_crystal_briefs",
        )

    assert verdict == "flag"
    assert trust_json["pass_3_grounding_completeness"]["grounding_failures"] == [{
        "clause": "<verification unavailable>",
        "reason": "grounding_completeness_check_failed_to_run",
    }]
