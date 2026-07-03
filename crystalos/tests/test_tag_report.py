"""Unit tests for crystalos/graphs/tag_report.py — the Tag Report cross-survey
checkpoint rollup pipeline (docs/tag-report/TRACKER.md §2, DESIGN.md).

Tag Report never generates fresh AI insight; it only reads existing
insight_checkpoints_v2 rows. Every test here mocks the DB layer and (for
narration) crystalos.lib.openrouter.call_agent — no real LLM/network calls,
per crystalos/CLAUDE.md's testing conventions.

Coverage follows TRACKER.md §2's own task list:
  - Loop control: all three exits (target_reached / ceiling_hit / pool_exhausted)
    tested independently, plus 'continue'.
  - Checkpoint resolution: manual/automated (latest) + custom_range (bracket
    pair, including the same-checkpoint "no comparison available" case).
  - Trust-weighted merge: 0/1/2/N-agreement cases.
  - Comparability formula: boundary values at each of the three zones, plus a
    regression test for the confirmed inversion bug the blend zone exists to fix.
  - Cost invariant: llm_call_count == len(qualifying metric tracks), for
    0/1/2/3-track fixtures and for N=5/20/50 survey fixtures end-to-end.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from crystalos.graphs.tag_report import (
    TagReportState,
    _compute_loop_decision,
    _direction,
    _find_metric_question,
    _metric_delta_value,
    _normalize_checkpoint_row,
    _offset_days,
    _parse_dt,
    _question_scale_for_metric,
    _fetch_checkpoint_cadence_days,
    _fetch_real_citations_for_checkpoint,
    _fetch_survey_questions,
    _route_after_gate,
    _survey_has_metric,
    _trust_statistical,
    build_tag_report_graph,
    compute_temporal_offset_tier,
    detect_metric_comparability_mismatches,
    node_apply_trend_eligibility_gate,
    node_check_cross_track_corroboration,
    node_compute_bracket_delta,
    node_detect_comparability_warnings,
    node_fetch_next_batch,
    node_merge_citation_manifest,
    node_merge_metric_tracks,
    node_narrate_tag_report,
    node_publish,
    node_resolve_and_gate_batch,
    resolve_boundary_checkpoints,
    run_tag_report_generation,
)


# ── Shared mock helpers ────────────────────────────────────────────────────────

def _make_pool(fetchall_return=None, fetchone_return=None, description=None):
    """A db._pool_conn()-shaped mock. fetchall/fetchone return whatever is given;
    description defaults to a generic column-name list wide enough for
    insight_checkpoints_v2's SELECT * shape used throughout this module."""
    mock_cur = AsyncMock()
    mock_cur.execute = AsyncMock()
    mock_cur.fetchall = AsyncMock(return_value=fetchall_return or [])
    mock_cur.fetchone = AsyncMock(return_value=fetchone_return)
    mock_cur.description = description or [(c,) for c in (
        "id", "survey_id", "org_id", "checkpoint_number", "parent_checkpoint_id", "lane",
        "run_id", "run_mode", "trigger", "created_by", "created_at",
        "response_count_at_checkpoint", "response_high_watermark", "new_response_count",
        "nps_at_checkpoint", "csat_at_checkpoint", "ces_at_checkpoint", "topic_fingerprint",
        "delta_from_prior", "meaningful_delta", "lineage_json",
        "report_blob_ref", "citations_manifest_ref", "schema_version",
        "window_start", "window_end", "report_label",
    )]
    mock_cur.__aenter__ = AsyncMock(return_value=mock_cur)
    mock_cur.__aexit__ = AsyncMock(return_value=False)

    mock_conn = AsyncMock()
    mock_conn.cursor = MagicMock(return_value=mock_cur)
    mock_conn.commit = AsyncMock()
    mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_conn.__aexit__ = AsyncMock(return_value=False)

    pool_ctx = MagicMock()
    pool_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
    pool_ctx.__aexit__ = AsyncMock(return_value=False)

    mock_pool = MagicMock()
    mock_pool.connection = MagicMock(return_value=pool_ctx)
    return mock_pool, mock_cur, mock_conn


def _checkpoint_row(
    id="ckpt-1", survey_id="s1", created_at="2026-03-01T00:00:00+00:00",
    response_count=100, nps=40.0, csat=None, ces=None, delta_from_prior=None,
    citations_manifest_ref=None, run_id=None,
):
    return {
        "id": id, "survey_id": survey_id, "created_at": created_at,
        "response_count_at_checkpoint": response_count,
        "nps_at_checkpoint": nps, "csat_at_checkpoint": csat, "ces_at_checkpoint": ces,
        "delta_from_prior": delta_from_prior,
        "citations_manifest_ref": citations_manifest_ref,
        "run_id": run_id,
    }


def _base_state(**overrides) -> TagReportState:
    state: TagReportState = {
        "org_id": "org1", "run_id": "run1", "tag_id": "tag1",
        "report_mode": "manual", "window_start": None, "window_end": None,
        "target_n": 5, "ceiling_n": 20, "batch_size": 3,
        "cursor": 0, "loop_iterations": 0,
        "candidate_pool": None, "current_batch": [],
        "included_surveys": [], "excluded_surveys": [],
        "boundary_checkpoints": {}, "bracket_deltas": {}, "bracket_topic_lifecycle": {},
        "metric_tracks": {}, "merge_votes": [], "corroboration_signals": [],
        "comparability_warnings": [], "narrated_tracks": {}, "llm_call_count": 0,
        "citation_manifest": [], "stream_events": [], "errors": [],
    }
    state.update(overrides)
    return state


# ── Pure helpers ───────────────────────────────────────────────────────────────

class TestParseAndOffsetHelpers:
    def test_parse_dt_handles_z_suffix(self):
        dt = _parse_dt("2026-03-01T00:00:00Z")
        assert dt is not None and dt.tzinfo is not None

    def test_parse_dt_none_and_garbage(self):
        assert _parse_dt(None) is None
        assert _parse_dt("not-a-date") is None

    def test_offset_days_signed(self):
        # actual is 2 days after requested -> positive offset
        assert _offset_days("2026-03-01T00:00:00Z", "2026-03-03T00:00:00Z") == 2.0
        # actual is 2 days before requested -> negative offset
        assert _offset_days("2026-03-03T00:00:00Z", "2026-03-01T00:00:00Z") == -2.0

    def test_direction(self):
        assert _direction(None) == "none"
        assert _direction(0.0) == "flat"
        assert _direction(3.2) == "up"
        assert _direction(-1.0) == "down"

    def test_metric_delta_value(self):
        assert _metric_delta_value(None, "nps") is None
        assert _metric_delta_value({"nps_delta": 4.0}, "nps") == 4.0
        assert _metric_delta_value({"nps_delta": 4.0}, "csat") is None

    def test_survey_has_metric(self):
        assert _survey_has_metric(None, "nps") is False
        assert _survey_has_metric({"nps_at_checkpoint": None}, "nps") is False
        assert _survey_has_metric({"nps_at_checkpoint": 40.0}, "nps") is True

    def test_normalize_checkpoint_row_casts_ids_and_metrics(self):
        row = {"id": 123, "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
               "nps_at_checkpoint": "40.5"}
        out = _normalize_checkpoint_row(row)
        assert out["id"] == "123"
        assert isinstance(out["created_at"], str)
        assert out["nps_at_checkpoint"] == 40.5


class TestTrustStatistical:
    def test_thresholds_match_platform_formula(self):
        assert _trust_statistical(150) == 90
        assert _trust_statistical(100) == 90
        assert _trust_statistical(60) == 80
        assert _trust_statistical(30) == 70
        assert _trust_statistical(0) == 10


# ── compute_temporal_offset_tier — the 3-zone blended formula (R-C2) ──────────

class TestComputeTemporalOffsetTier:
    """Boundary values at each of the three zones (<10d absolute, >=18d ratio,
    10-18d blend-zone-stricter-of-both), per DESIGN.md R-C2 — implemented
    exactly as specified since two prior versions each had a confirmed bug."""

    @pytest.mark.parametrize("total_offset,expected", [
        (1.0, "high"), (3.0, "medium"), (7.0, "low"), (7.01, "severe"),
    ])
    def test_absolute_zone_boundaries(self, total_offset, expected):
        # requested_span_days < 10 -> pure absolute-day tiering
        tier, score = compute_temporal_offset_tier(5, total_offset, 0.0)
        assert tier == expected
        assert score == total_offset

    @pytest.mark.parametrize("ratio,total_offset,expected", [
        (0.1, 2.0, "high"), (0.5, 10.0, "medium"), (1.0, 20.0, "low"), (1.01, 20.2, "severe"),
    ])
    def test_ratio_zone_boundaries(self, ratio, total_offset, expected):
        # requested_span_days >= 18 -> pure ratio tiering
        span = 20
        tier, score = compute_temporal_offset_tier(span, total_offset / 2, total_offset / 2)
        assert tier == expected
        assert math.isclose(score, ratio, rel_tol=1e-6)

    def test_blend_zone_uses_stricter_of_both(self):
        # span=12 (in [10,18)); total_offset=8 -> absolute tier "severe" (>7),
        # ratio = 8/12 = 0.667 -> ratio tier "low". Stricter (severe) must win.
        tier, _ = compute_temporal_offset_tier(12, 4.0, 4.0)
        assert tier == "severe"

    def test_blend_zone_ratio_stricter_than_absolute(self):
        # span=10 (blend zone), total_offset=1.75+1.75=3.5.
        # absolute tier: 3.5 is >3 and <=7 -> "low".
        # ratio tier: 3.5/10 = 0.35, <=0.5 -> "medium".
        # Severity order is high < medium < low < severe, so "low" (severity 2)
        # is STRICTER than "medium" (severity 1) — the blend zone must pick the
        # stricter one ("low"), demonstrating the absolute tier can be the
        # binding constraint even inside the blend zone.
        tier, _ = compute_temporal_offset_tier(10, 1.75, 1.75)
        assert tier == "low"

    def test_no_inversion_bug_regression(self):
        """Regression test for the confirmed inversion bug a hard 14-day cutover
        introduced: a NARROWER window must never score a BETTER (less severe)
        tier than a WIDER window at the identical absolute offset. This is the
        exact defect the blend zone (10-18d, stricter-of-both) was added to fix.

        NOTE (2026-07-03 QA finding): this specific pair (span 11 vs 17, offset 8)
        does not actually discriminate a correct implementation from a naive hard-
        cutover one — both resolve to "severe" via the absolute-offset check alone
        at these particular values, so a buggy implementation would pass this
        exact assertion too. Kept as a smoke-test/documentation of the intent, but
        the real regression guard is test_tier_severity_never_improves_as_span_
        narrows_at_fixed_offset below, which sweeps many span/offset combinations
        and checks the actual monotonicity property directly, rather than relying
        on two hand-picked points that happen to coincide."""
        narrower_tier, _ = compute_temporal_offset_tier(11, 4.0, 4.0)   # total offset 8, in blend zone
        wider_tier, _ = compute_temporal_offset_tier(17, 4.0, 4.0)     # total offset 8, in blend zone
        severity = {"high": 0, "medium": 1, "low": 2, "severe": 3}
        # Narrower window's tier must be at least as severe as the wider one's.
        assert severity[narrower_tier] >= severity[wider_tier]

    def test_tier_severity_never_improves_as_span_narrows_at_fixed_offset(self):
        """The actual invariant the blend zone exists to guarantee, tested
        directly rather than via two hand-picked points (see the note on
        test_no_inversion_bug_regression above, added after a QA review found
        that test doesn't discriminate a buggy hard-cutover implementation from
        the correct one). For any fixed absolute offset, as the requested span
        widens, the confidence tier must never become MORE severe — a wider
        window must tolerate at least as much absolute drift as a narrower one
        at the identical offset.

        Honesty note: with the CURRENT final threshold constants (1/3/7 days,
        0.1/0.5/1.0 ratio), a hard single-cutover implementation was empirically
        checked (via a throwaway script, not committed) and does NOT actually
        violate this property at any point across a fine offset/span grid — the
        two threshold ladders happen to be mutually consistent enough that the
        originally-documented inversion must have occurred with different,
        since-superseded threshold values no longer present in the codebase, not
        reproducible bit-for-bit with today's numbers. This test is therefore not
        a literal historical-bug repro; it is a direct, rigorous check of the
        actual monotonicity invariant the design relies on, which will catch a
        FUTURE threshold change or cutover reintroduction that breaks it, even
        though it can't retroactively prove the original incident."""
        severity = {"high": 0, "medium": 1, "low": 2, "severe": 3}
        offsets = [0.5, 1.0, 1.5, 2.0, 3.0, 3.5, 5.0, 7.0, 7.5, 9.0, 12.0]
        spans = [3, 5, 8, 9.5, 10, 11, 13, 14, 14.5, 15, 17, 18, 18.5, 20, 30, 50, 100]
        for offset in offsets:
            prior_severity = None
            for span in spans:
                tier, _ = compute_temporal_offset_tier(span, offset / 2, offset / 2)
                current_severity = severity[tier]
                if prior_severity is not None:
                    assert current_severity <= prior_severity, (
                        f"offset={offset}: span={span} scored MORE severe "
                        f"({tier}) than a narrower span at the same offset "
                        f"(prior severity={prior_severity}) — this is exactly "
                        f"the inversion bug the blend zone exists to prevent."
                    )
                prior_severity = current_severity


# ── Loop control — the three exits + continue ─────────────────────────────────

class TestLoopDecisionAndRouter:
    def test_target_reached(self):
        assert _compute_loop_decision(included_count=5, cursor=5, pool_size=50, target_n=5, ceiling_n=20) == "target_reached"

    def test_ceiling_hit(self):
        assert _compute_loop_decision(included_count=2, cursor=20, pool_size=50, target_n=5, ceiling_n=20) == "ceiling_hit"

    def test_pool_exhausted(self):
        assert _compute_loop_decision(included_count=1, cursor=8, pool_size=8, target_n=5, ceiling_n=20) == "pool_exhausted"

    def test_continue(self):
        assert _compute_loop_decision(included_count=1, cursor=3, pool_size=50, target_n=5, ceiling_n=20) == "continue"

    def test_route_after_gate_matches_decision_helper(self):
        state = _base_state(included_surveys=[{"survey_id": "s1"}] * 5,
                             candidate_pool=[{}] * 50, cursor=5, target_n=5, ceiling_n=20)
        assert _route_after_gate(state) == "target_reached"


# ── resolve_boundary_checkpoints (reusable library function) ─────────────────

class TestResolveBoundaryCheckpoints:
    @pytest.mark.asyncio
    async def test_manual_mode_fetches_latest(self):
        row = tuple(_checkpoint_row().get(c[0]) for c in [(k,) for k in _checkpoint_row().keys()])
        cols = list(_checkpoint_row().keys())
        pool, cur, _ = _make_pool(fetchone_return=row, description=[(c,) for c in cols])
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await resolve_boundary_checkpoints("s1", "org1", "manual", None, None)
        assert result["single"]["id"] == "ckpt-1"

    @pytest.mark.asyncio
    async def test_manual_mode_no_checkpoint(self):
        pool, _, _ = _make_pool(fetchone_return=None)
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await resolve_boundary_checkpoints("s1", "org1", "manual", None, None)
        assert result == {"single": None}

    @pytest.mark.asyncio
    async def test_custom_range_resolves_both_boundaries(self):
        cols = list(_checkpoint_row().keys())
        row = tuple(_checkpoint_row().values())
        pool, _, _ = _make_pool(fetchone_return=row, description=[(c,) for c in cols])
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await resolve_boundary_checkpoints(
                "s1", "org1", "custom_range", "2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z",
            )
        assert "start" in result and "end" in result
        assert result["start"]["id"] == "ckpt-1"


# ── node_fetch_next_batch ──────────────────────────────────────────────────────

class TestNodeFetchNextBatch:
    @pytest.mark.asyncio
    async def test_first_call_queries_db_and_slices_batch(self):
        rows = [(f"s{i}", f"Survey {i}", f"2026-0{i}-01T00:00:00Z") for i in range(1, 6)]
        pool, cur, _ = _make_pool(fetchall_return=rows, description=[("id",), ("title",), ("created_at",)])
        state = _base_state(batch_size=2)
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await node_fetch_next_batch(state)
        assert len(result["candidate_pool"]) == 5
        assert len(result["current_batch"]) == 2
        assert result["cursor"] == 2
        events = [e["event"] for e in result["stream_events"]]
        assert events.count("survey_selected") == 2
        assert "batch_fetched" in events

    @pytest.mark.asyncio
    async def test_subsequent_call_reuses_cached_pool_no_db_call(self):
        pool_rows = [{"id": f"s{i}", "title": f"S{i}"} for i in range(5)]
        state = _base_state(candidate_pool=pool_rows, cursor=2, batch_size=2)
        with patch("crystalos.graphs.tag_report.db._pool_conn") as mock_pool_conn:
            result = await node_fetch_next_batch(state)
        mock_pool_conn.assert_not_called()
        assert result["cursor"] == 4
        assert len(result["current_batch"]) == 2


# ── node_resolve_and_gate_batch ────────────────────────────────────────────────

class TestNodeResolveAndGateBatch:
    @pytest.mark.asyncio
    async def test_manual_survey_above_floor_is_trend_eligible(self):
        ckpt = _checkpoint_row(response_count=100, nps=45.0)
        state = _base_state(report_mode="manual", current_batch=[{"id": "s1", "title": "Survey 1"}])
        with patch("crystalos.graphs.tag_report.resolve_boundary_checkpoints",
                   new=AsyncMock(return_value={"single": ckpt})):
            result = await node_resolve_and_gate_batch(state)
        assert len(result["included_surveys"]) == 1
        assert result["included_surveys"][0]["trend_eligible"] is True
        assert result["excluded_surveys"] == []

    @pytest.mark.asyncio
    async def test_manual_survey_below_response_floor_is_included_but_not_trend_eligible(self):
        ckpt = _checkpoint_row(response_count=5, nps=45.0)
        state = _base_state(report_mode="manual", current_batch=[{"id": "s1", "title": "Survey 1"}])
        with patch("crystalos.graphs.tag_report.resolve_boundary_checkpoints",
                   new=AsyncMock(return_value={"single": ckpt})):
            result = await node_resolve_and_gate_batch(state)
        # R-T1: below-threshold survey still appears (descriptive), just not trend-eligible.
        assert len(result["included_surveys"]) == 1
        assert result["included_surveys"][0]["trend_eligible"] is False
        assert result["excluded_surveys"] == []

    @pytest.mark.asyncio
    async def test_manual_survey_with_no_checkpoint_is_hard_excluded(self):
        state = _base_state(report_mode="manual", current_batch=[{"id": "s1", "title": "Survey 1"}])
        with patch("crystalos.graphs.tag_report.resolve_boundary_checkpoints",
                   new=AsyncMock(return_value={"single": None})):
            result = await node_resolve_and_gate_batch(state)
        assert result["included_surveys"] == []
        assert len(result["excluded_surveys"]) == 1
        assert result["excluded_surveys"][0]["reason"] == "no_checkpoint_in_range"

    @pytest.mark.asyncio
    async def test_custom_range_no_checkpoint_before_start_is_excluded(self):
        state = _base_state(report_mode="custom_range", window_start="2026-01-01T00:00:00Z",
                             window_end="2026-06-01T00:00:00Z",
                             current_batch=[{"id": "s1", "title": "Survey 1"}])
        with patch("crystalos.graphs.tag_report.resolve_boundary_checkpoints",
                   new=AsyncMock(return_value={"start": None, "end": _checkpoint_row()})):
            result = await node_resolve_and_gate_batch(state)
        assert result["excluded_surveys"][0]["reason"] == "no_checkpoint_in_range"
        assert result["included_surveys"] == []

    @pytest.mark.asyncio
    async def test_custom_range_same_checkpoint_is_not_trend_eligible(self):
        ckpt = _checkpoint_row(id="ckpt-only", response_count=100)
        state = _base_state(report_mode="custom_range", window_start="2026-01-01T00:00:00Z",
                             window_end="2026-06-01T00:00:00Z",
                             current_batch=[{"id": "s1", "title": "Survey 1"}])
        with patch("crystalos.graphs.tag_report.resolve_boundary_checkpoints",
                   new=AsyncMock(return_value={"start": ckpt, "end": ckpt})):
            result = await node_resolve_and_gate_batch(state)
        survey = result["included_surveys"][0]
        assert survey["same_checkpoint"] is True
        assert survey["trend_eligible"] is False

    @pytest.mark.asyncio
    async def test_custom_range_severe_offset_is_not_trend_eligible(self):
        # Requested window is 20 days (>=18d -> ratio zone). Actual checkpoints
        # land far outside it in both directions: start_offset = -120d,
        # end_offset = +40d -> total_offset=160, ratio=160/20=8.0 -> severe.
        start = _checkpoint_row(id="ckpt-start", created_at="2026-01-01T00:00:00+00:00", response_count=100)
        end = _checkpoint_row(id="ckpt-end", created_at="2026-06-30T00:00:00+00:00", response_count=100)
        state = _base_state(report_mode="custom_range", window_start="2026-05-01T00:00:00Z",
                             window_end="2026-05-21T00:00:00Z",
                             current_batch=[{"id": "s1", "title": "Survey 1"}])
        with patch("crystalos.graphs.tag_report.resolve_boundary_checkpoints",
                   new=AsyncMock(return_value={"start": start, "end": end})):
            result = await node_resolve_and_gate_batch(state)
        survey = result["included_surveys"][0]
        assert survey["temporal_offset_tier"] == "severe"
        assert survey["trend_eligible"] is False

    @pytest.mark.asyncio
    async def test_emits_batch_loop_resolved_only_when_not_continuing(self):
        ckpt = _checkpoint_row(response_count=100)
        state = _base_state(report_mode="manual", current_batch=[{"id": "s1", "title": "S1"}],
                             candidate_pool=[{}] * 10, cursor=1, target_n=1, ceiling_n=20)
        with patch("crystalos.graphs.tag_report.resolve_boundary_checkpoints",
                   new=AsyncMock(return_value={"single": ckpt})):
            result = await node_resolve_and_gate_batch(state)
        events = [e["event"] for e in result["stream_events"]]
        assert "batch_loop_resolved" in events
        assert result["loop_stop_reason"] == "target_reached"


# ── node_compute_bracket_delta ─────────────────────────────────────────────────

class TestNodeComputeBracketDelta:
    @pytest.mark.asyncio
    async def test_manual_mode_reuses_delta_from_prior_unmodified(self):
        ckpt = _checkpoint_row(delta_from_prior={"nps_delta": 3.5, "csat_delta": None, "ces_delta": None})
        state = _base_state(report_mode="manual", boundary_checkpoints={"s1": {"single": ckpt}})
        result = await node_compute_bracket_delta(state)
        assert result["bracket_deltas"]["s1"]["nps_delta"] == 3.5

    @pytest.mark.asyncio
    async def test_manual_mode_handles_json_string_delta(self):
        ckpt = _checkpoint_row(delta_from_prior='{"nps_delta": 2.0}')
        state = _base_state(report_mode="manual", boundary_checkpoints={"s1": {"single": ckpt}})
        result = await node_compute_bracket_delta(state)
        assert result["bracket_deltas"]["s1"]["nps_delta"] == 2.0

    @pytest.mark.asyncio
    async def test_custom_range_computes_delta_between_bracket_pair(self):
        start = _checkpoint_row(id="c1", nps=40.0)
        end = _checkpoint_row(id="c2", nps=48.0)
        state = _base_state(report_mode="custom_range",
                             boundary_checkpoints={"s1": {"start": start, "end": end, "same_checkpoint": False}})
        result = await node_compute_bracket_delta(state)
        assert result["bracket_deltas"]["s1"]["nps_delta"] == 8.0
        events = [e["event"] for e in result["stream_events"]]
        assert "bracket_delta_computed" in events

    @pytest.mark.asyncio
    async def test_custom_range_same_checkpoint_yields_no_comparison_marker(self):
        ckpt = _checkpoint_row(id="c1")
        state = _base_state(report_mode="custom_range",
                             boundary_checkpoints={"s1": {"start": ckpt, "end": ckpt, "same_checkpoint": True}})
        result = await node_compute_bracket_delta(state)
        delta = result["bracket_deltas"]["s1"]
        assert delta["no_comparison_available"] is True
        assert delta["nps_delta"] is None


# ── node_apply_trend_eligibility_gate ──────────────────────────────────────────

class TestNodeApplyTrendEligibilityGate:
    @pytest.mark.asyncio
    async def test_partitions_independently_per_metric(self):
        nps_only = _checkpoint_row(id="c1", nps=40.0, csat=None)
        csat_only = _checkpoint_row(id="c2", nps=None, csat=4.2)
        state = _base_state(
            included_surveys=[
                {"survey_id": "s1", "trend_eligible": True, "response_count": 100},
                {"survey_id": "s2", "trend_eligible": True, "response_count": 100},
            ],
            boundary_checkpoints={"s1": {"single": nps_only}, "s2": {"single": csat_only}},
        )
        result = await node_apply_trend_eligibility_gate(state)
        assert result["metric_tracks"]["nps"]["eligible_survey_ids"] == ["s1"]
        assert result["metric_tracks"]["csat"]["eligible_survey_ids"] == ["s2"]
        assert result["metric_tracks"]["ces"]["eligible"] is False

    @pytest.mark.asyncio
    async def test_trend_ineligible_survey_excluded_from_metric_track(self):
        ckpt = _checkpoint_row(nps=40.0)
        state = _base_state(
            included_surveys=[{"survey_id": "s1", "trend_eligible": False, "response_count": 5}],
            boundary_checkpoints={"s1": {"single": ckpt}},
        )
        result = await node_apply_trend_eligibility_gate(state)
        assert result["metric_tracks"]["nps"]["eligible_survey_ids"] == []
        assert "s1" in result["metric_tracks"]["nps"]["excluded_survey_ids"]


# ── node_merge_metric_tracks — 0/1/2/N agreement ──────────────────────────────

class TestNodeMergeMetricTracks:
    def _state_for(self, eligible_ids, deltas, response_counts):
        included = [{"survey_id": sid, "response_count": response_counts.get(sid, 100)} for sid in eligible_ids]
        return _base_state(
            included_surveys=included,
            bracket_deltas=deltas,
            metric_tracks={"nps": {"eligible": bool(eligible_ids), "eligible_survey_ids": eligible_ids,
                                    "excluded_survey_ids": [], "trend_gate_passed": bool(eligible_ids)}},
        )

    @pytest.mark.asyncio
    async def test_zero_eligible_surveys_yields_no_merge_and_no_votes(self):
        state = self._state_for([], {}, {})
        result = await node_merge_metric_tracks(state)
        track = result["metric_tracks"]["nps"]
        assert track["agreement_count"] == 0
        assert track["merged_delta"] is None
        assert track["confidence_tier"] == "insufficient"

    @pytest.mark.asyncio
    async def test_one_eligible_survey_is_single_survey_sourced_and_insufficient(self):
        state = self._state_for(["s1"], {"s1": {"nps_delta": 5.0}}, {"s1": 100})
        result = await node_merge_metric_tracks(state)
        track = result["metric_tracks"]["nps"]
        assert track["agreement_count"] == 1
        assert track["confidence_tier"] == "insufficient"
        assert track["single_survey_id"] == "s1"
        # R-T2a: descriptive number is still shown, not blanked.
        assert track["merged_delta"] == 5.0

    @pytest.mark.asyncio
    async def test_two_agreeing_surveys_clears_the_agreement_floor(self):
        state = self._state_for(
            ["s1", "s2"], {"s1": {"nps_delta": 4.0}, "s2": {"nps_delta": 6.0}}, {"s1": 100, "s2": 100},
        )
        result = await node_merge_metric_tracks(state)
        track = result["metric_tracks"]["nps"]
        assert track["agreement_count"] == 2
        assert track["confidence_tier"] == "confirmed"
        assert track["merged_delta"] is not None

    @pytest.mark.asyncio
    async def test_n_surveys_disagreeing_direction_uses_majority(self):
        deltas = {"s1": {"nps_delta": 5.0}, "s2": {"nps_delta": 4.0}, "s3": {"nps_delta": -1.0}}
        state = self._state_for(["s1", "s2", "s3"], deltas, {"s1": 100, "s2": 100, "s3": 100})
        result = await node_merge_metric_tracks(state)
        track = result["metric_tracks"]["nps"]
        assert track["direction"] == "up"
        assert track["agreement_count"] == 2
        assert track["confidence_tier"] == "confirmed"

    @pytest.mark.asyncio
    async def test_higher_trust_survey_weighted_more_heavily(self):
        deltas = {"s1": {"nps_delta": 10.0}, "s2": {"nps_delta": 2.0}}
        state = self._state_for(["s1", "s2"], deltas, {"s1": 200, "s2": 31})
        result = await node_merge_metric_tracks(state)
        track = result["metric_tracks"]["nps"]
        # s1 has far more responses (higher trust + higher log(n)) -> merged
        # delta should sit closer to s1's 10.0 than to a naive average of 6.0.
        assert track["merged_delta"] > 6.0

    @pytest.mark.asyncio
    async def test_three_surveys_no_majority_names_the_single_agreeing_survey(self):
        """Regression test (2026-07-03 QA finding): single_survey_id previously
        only fired when len(eligible_ids) == 1 (the trivial R-T2a case) — it
        silently stayed None whenever >=2 eligible surveys existed but only one
        actually agreed on a direction (e.g. up/down/flat across 3 surveys),
        exactly the general case R-T2's AC text describes ("if only one
        trend-eligible survey supports a direction... naming that survey").
        3 surveys: s1 up, s2 down, s3 flat -> direction_counts {up:1, down:1},
        majority_direction picks whichever key comes first (up, since dict
        insertion order is up-then-down here) with agreement_count=1."""
        deltas = {"s1": {"nps_delta": 5.0}, "s2": {"nps_delta": -3.0}, "s3": {"nps_delta": 0.0}}
        state = self._state_for(["s1", "s2", "s3"], deltas, {"s1": 100, "s2": 100, "s3": 100})
        result = await node_merge_metric_tracks(state)
        track = result["metric_tracks"]["nps"]
        assert track["agreement_count"] == 1
        assert track["confidence_tier"] == "insufficient"
        # The bug: this was None before the fix, even though exactly one survey
        # (s1, the sole "up" voter) unambiguously supports the reported direction.
        assert track["single_survey_id"] == "s1"

    @pytest.mark.asyncio
    async def test_no_survey_named_when_zero_surveys_support_any_direction(self):
        """All-flat votes -> agreement_count=0, majority_direction='flat' — there
        is no single agreeing survey to name, and this is not the R-T2a trivial
        case either (2 eligible surveys), so single_survey_id must stay None."""
        deltas = {"s1": {"nps_delta": 0.0}, "s2": {"nps_delta": 0.0}}
        state = self._state_for(["s1", "s2"], deltas, {"s1": 100, "s2": 100})
        result = await node_merge_metric_tracks(state)
        track = result["metric_tracks"]["nps"]
        assert track["agreement_count"] == 0
        assert track["single_survey_id"] is None


# ── node_check_cross_track_corroboration ──────────────────────────────────────

class TestNodeCheckCrossTrackCorroboration:
    @pytest.mark.asyncio
    async def test_detects_agreement_with_overlap(self):
        state = _base_state(metric_tracks={
            "nps": {"trend_gate_passed": True, "direction": "up", "eligible_survey_ids": ["s1", "s2"]},
            "csat": {"trend_gate_passed": True, "direction": "up", "eligible_survey_ids": ["s2", "s3"]},
        })
        result = await node_check_cross_track_corroboration(state)
        assert len(result["corroboration_signals"]) == 1
        assert result["corroboration_signals"][0]["overlap_surveys"] == ["s2"]

    @pytest.mark.asyncio
    async def test_no_signal_when_directions_differ(self):
        state = _base_state(metric_tracks={
            "nps": {"trend_gate_passed": True, "direction": "up", "eligible_survey_ids": ["s1"]},
            "csat": {"trend_gate_passed": True, "direction": "down", "eligible_survey_ids": ["s1"]},
        })
        result = await node_check_cross_track_corroboration(state)
        assert result["corroboration_signals"] == []

    @pytest.mark.asyncio
    async def test_never_mutates_metric_tracks(self):
        original_tracks = {
            "nps": {"trend_gate_passed": True, "direction": "up", "eligible_survey_ids": ["s1", "s2"],
                    "merged_delta": 4.2},
            "csat": {"trend_gate_passed": True, "direction": "up", "eligible_survey_ids": ["s2"],
                     "merged_delta": 0.3},
        }
        state = _base_state(metric_tracks=original_tracks)
        result = await node_check_cross_track_corroboration(state)
        # metric_tracks key is not even part of this node's return.
        assert "metric_tracks" not in result
        assert original_tracks["nps"]["merged_delta"] == 4.2
        assert original_tracks["csat"]["merged_delta"] == 0.3


# ── node_detect_comparability_warnings ────────────────────────────────────────

class TestNodeDetectComparabilityWarnings:
    @pytest.mark.asyncio
    async def test_custom_range_emits_temporal_offset_warning(self):
        state = _base_state(report_mode="custom_range", included_surveys=[{
            "survey_id": "s1", "bracket_position": "start_end", "same_checkpoint": False,
            "temporal_offset_tier": "severe", "temporal_distortion_score": 1.5,
        }])
        result = await node_detect_comparability_warnings(state)
        assert len(result["comparability_warnings"]) == 1
        assert result["comparability_warnings"][0]["warning_type"] == "temporal_offset"
        assert result["comparability_warnings"][0]["confidence_tier"] == "severe"

    @pytest.mark.asyncio
    async def test_custom_range_skips_same_checkpoint_survey(self):
        state = _base_state(report_mode="custom_range", included_surveys=[{
            "survey_id": "s1", "bracket_position": "start_end", "same_checkpoint": True,
            "temporal_offset_tier": "high", "temporal_distortion_score": 0.0,
        }])
        result = await node_detect_comparability_warnings(state)
        assert result["comparability_warnings"] == []

    @pytest.mark.asyncio
    async def test_automated_mode_flags_stale_outlier_survey(self):
        now = datetime.now(timezone.utc)
        fresh = (now - timedelta(days=2)).isoformat()
        also_fresh = (now - timedelta(days=3)).isoformat()
        stale = (now - timedelta(days=40)).isoformat()
        state = _base_state(
            report_mode="automated",
            included_surveys=[
                {"survey_id": "s1"}, {"survey_id": "s2"}, {"survey_id": "s3"},
            ],
            boundary_checkpoints={
                "s1": {"single": {"created_at": fresh}},
                "s2": {"single": {"created_at": also_fresh}},
                "s3": {"single": {"created_at": stale}},
            },
        )
        result = await node_detect_comparability_warnings(state)
        staleness_warnings = [w for w in result["comparability_warnings"] if w["warning_type"] == "staleness"]
        assert len(staleness_warnings) == 1
        assert staleness_warnings[0]["affected_survey_ids"] == ["s3"]

    @pytest.mark.asyncio
    async def test_automated_mode_no_warning_when_ages_are_close(self):
        now = datetime.now(timezone.utc)
        state = _base_state(
            report_mode="automated",
            included_surveys=[{"survey_id": "s1"}, {"survey_id": "s2"}],
            boundary_checkpoints={
                "s1": {"single": {"created_at": (now - timedelta(days=1)).isoformat()}},
                "s2": {"single": {"created_at": (now - timedelta(days=2)).isoformat()}},
            },
        )
        result = await node_detect_comparability_warnings(state)
        assert result["comparability_warnings"] == []

    @pytest.mark.asyncio
    async def test_wires_metric_comparability_checks_for_every_metric_track_regardless_of_mode(self):
        """R-T3 regression test (2026-07-03 QA finding): this was previously an
        unconditional no-op despite DESIGN.md declaring the full Trust Layer
        non-negotiable v1 scope. Verifies the node actually calls the new
        detection helper per metric_key and merges its warnings in, for manual
        mode too (not just automated/custom_range's mode-specific checks)."""
        state = _base_state(
            report_mode="manual",
            metric_tracks={
                "nps": {"eligible_survey_ids": ["s1", "s2"]},
                "csat": {"eligible_survey_ids": ["s1"]},  # single survey -> nothing to compare
            },
        )
        fake_warning = {"scope": "metric", "warning_type": "scale_mismatch", "distortion_score": 2.0,
                         "confidence_tier": "severe", "affected_survey_ids": ["s1", "s2"], "metric_key": "nps"}
        with patch("crystalos.graphs.tag_report.detect_metric_comparability_mismatches",
                   new=AsyncMock(side_effect=lambda mk, ids, org: [fake_warning] if mk == "nps" else [])) as mock_detect:
            result = await node_detect_comparability_warnings(state)
        assert mock_detect.call_count == 2  # once per metric_key in metric_tracks
        assert fake_warning in result["comparability_warnings"]
        events = [e["event"] for e in result["stream_events"]]
        assert events.count("comparability_warning") == 1


# ── detect_metric_comparability_mismatches (R-T3, added 2026-07-03) ──────────

class TestQuestionScaleAndTypeHelpers:
    def test_canonical_scales_for_metric_typed_questions(self):
        assert _question_scale_for_metric({"type": "nps"}) == (0.0, 10.0)
        assert _question_scale_for_metric({"type": "csat"}) == (1.0, 5.0)
        assert _question_scale_for_metric({"type": "ces"}) == (1.0, 7.0)

    def test_rating_question_uses_scale_max_with_default(self):
        assert _question_scale_for_metric({"type": "rating", "scaleMax": 10}) == (1.0, 10.0)
        assert _question_scale_for_metric({"type": "rating"}) == (1.0, 5.0)
        assert _question_scale_for_metric({"type": "rating", "scaleMax": "not-a-number"}) == (1.0, 5.0)

    def test_slider_question_uses_min_max_with_defaults(self):
        assert _question_scale_for_metric({"type": "slider", "min": 1, "max": 7}) == (1.0, 7.0)
        assert _question_scale_for_metric({"type": "slider"}) == (0.0, 100.0)

    def test_non_scale_question_types_return_none(self):
        assert _question_scale_for_metric({"type": "open_text"}) is None
        assert _question_scale_for_metric({"type": "multiple_choice"}) is None

    def test_find_metric_question_exact_type_match(self):
        questions = [{"type": "open_text"}, {"type": "nps", "id": "q2"}]
        assert _find_metric_question(questions, "nps") == {"type": "nps", "id": "q2"}

    def test_find_metric_question_falls_back_to_rating_for_csat_and_ces_only(self):
        questions = [{"type": "rating", "scaleMax": 5, "id": "q1"}]
        assert _find_metric_question(questions, "csat") == questions[0]
        assert _find_metric_question(questions, "ces") == questions[0]
        # NPS has no such ambiguity — no fallback for it.
        assert _find_metric_question(questions, "nps") is None

    def test_find_metric_question_returns_none_when_absent(self):
        assert _find_metric_question([{"type": "open_text"}], "nps") is None
        assert _find_metric_question(None, "nps") is None
        assert _find_metric_question([], "nps") is None


class TestFetchSurveyQuestions:
    @pytest.mark.asyncio
    async def test_returns_empty_dict_for_empty_survey_id_list(self):
        # No DB mock installed — would raise if it didn't short-circuit.
        assert await _fetch_survey_questions([], "org1") == {}

    @pytest.mark.asyncio
    async def test_maps_survey_id_to_its_questions(self):
        pool, cur, conn = _make_pool()
        cur.fetchall = AsyncMock(return_value=[
            ("s1", [{"type": "nps"}]),
            ("s2", [{"type": "rating", "scaleMax": 10}]),
        ])
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await _fetch_survey_questions(["s1", "s2"], "org1")
        assert result == {"s1": [{"type": "nps"}], "s2": [{"type": "rating", "scaleMax": 10}]}

    @pytest.mark.asyncio
    async def test_db_failure_returns_empty_dict_rather_than_raising(self):
        pool, cur, conn = _make_pool()
        cur.execute = AsyncMock(side_effect=RuntimeError("connection refused"))
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await _fetch_survey_questions(["s1"], "org1")
        assert result == {}


class TestFetchCheckpointCadenceDays:
    @pytest.mark.asyncio
    async def test_returns_none_with_fewer_than_two_checkpoints(self):
        pool, cur, conn = _make_pool()
        cur.fetchall = AsyncMock(return_value=[("2026-03-01T00:00:00+00:00",)])
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await _fetch_checkpoint_cadence_days("s1", "org1")
        assert result is None

    @pytest.mark.asyncio
    async def test_computes_median_gap_in_days(self):
        pool, cur, conn = _make_pool()
        # 3 checkpoints, 7 days apart each -> median gap 7.
        cur.fetchall = AsyncMock(return_value=[
            ("2026-03-15T00:00:00+00:00",), ("2026-03-08T00:00:00+00:00",), ("2026-03-01T00:00:00+00:00",),
        ])
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await _fetch_checkpoint_cadence_days("s1", "org1")
        assert result == 7.0

    @pytest.mark.asyncio
    async def test_db_failure_returns_none_rather_than_raising(self):
        pool, cur, conn = _make_pool()
        cur.execute = AsyncMock(side_effect=RuntimeError("connection refused"))
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await _fetch_checkpoint_cadence_days("s1", "org1")
        assert result is None


class TestDetectMetricComparabilityMismatches:
    @pytest.mark.asyncio
    async def test_fewer_than_two_eligible_surveys_yields_no_warnings(self):
        result = await detect_metric_comparability_mismatches("nps", ["s1"], "org1")
        assert result == []
        result = await detect_metric_comparability_mismatches("nps", [], "org1")
        assert result == []

    @pytest.mark.asyncio
    async def test_scale_mismatch_detected_between_0_10_and_1_5_csat_style_scales(self):
        """The exact DESIGN.md R-T3 example: 'scale mismatch e.g. 0-10 vs 1-5'."""
        pool, cur, conn = _make_pool()
        cur.fetchall = AsyncMock(side_effect=[
            [("s1", [{"type": "rating", "scaleMax": 10}]), ("s2", [{"type": "csat"}])],  # questions
            [],  # s1 cadence
            [],  # s2 cadence
        ])
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await detect_metric_comparability_mismatches("csat", ["s1", "s2"], "org1")
        scale_warnings = [w for w in result if w["warning_type"] == "scale_mismatch"]
        assert len(scale_warnings) == 1
        assert scale_warnings[0]["metric_key"] == "csat"
        assert set(scale_warnings[0]["affected_survey_ids"]) == {"s1", "s2"}
        assert scale_warnings[0]["confidence_tier"] == "severe"  # (10-1)=9 vs (5-1)=4, ratio 2.25

    @pytest.mark.asyncio
    async def test_question_type_mismatch_detected_when_metric_measured_by_different_question_types(self):
        pool, cur, conn = _make_pool()
        cur.fetchall = AsyncMock(side_effect=[
            [("s1", [{"type": "csat"}]), ("s2", [{"type": "rating", "scaleMax": 5}])],
            [], [],
        ])
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await detect_metric_comparability_mismatches("csat", ["s1", "s2"], "org1")
        type_warnings = [w for w in result if w["warning_type"] == "question_type_mismatch"]
        assert len(type_warnings) == 1
        assert set(type_warnings[0]["affected_survey_ids"]) == {"s1", "s2"}

    @pytest.mark.asyncio
    async def test_no_warnings_when_all_surveys_use_identical_type_and_scale(self):
        pool, cur, conn = _make_pool()
        cur.fetchall = AsyncMock(side_effect=[
            [("s1", [{"type": "nps"}]), ("s2", [{"type": "nps"}])],
            [], [],
        ])
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await detect_metric_comparability_mismatches("nps", ["s1", "s2"], "org1")
        assert result == []

    @pytest.mark.asyncio
    async def test_cadence_mismatch_detected_when_intervals_diverge_beyond_threshold(self):
        pool, cur, conn = _make_pool()
        cur.fetchall = AsyncMock(side_effect=[
            [("s1", [{"type": "nps"}]), ("s2", [{"type": "nps"}])],  # questions — identical, no scale/type warning
            [("2026-03-08T00:00:00+00:00",), ("2026-03-01T00:00:00+00:00",)],  # s1: 7-day cadence
            [("2026-03-22T00:00:00+00:00",), ("2026-01-22T00:00:00+00:00",)],  # s2: 60-day cadence
        ])
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await detect_metric_comparability_mismatches("nps", ["s1", "s2"], "org1")
        cadence_warnings = [w for w in result if w["warning_type"] == "cadence_mismatch"]
        assert len(cadence_warnings) == 1
        assert cadence_warnings[0]["confidence_tier"] == "severe"  # ratio 60/7 ≈ 8.6

    @pytest.mark.asyncio
    async def test_missing_question_for_a_survey_excludes_it_from_the_comparison_without_raising(self):
        pool, cur, conn = _make_pool()
        cur.fetchall = AsyncMock(side_effect=[
            [("s1", [{"type": "nps"}])],  # s2 has no matching question at all
            [], [],
        ])
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await detect_metric_comparability_mismatches("nps", ["s1", "s2"], "org1")
        # Only one survey resolved a question -> nothing to compare, no crash.
        assert result == []


# ── node_narrate_tag_report — cost invariant at the node level ────────────────

class TestNodeNarrateTagReport:
    def _mock_output(self):
        out = MagicMock()
        out.headline = "Headline"
        out.narrative = "Narrative."
        return out

    @pytest.mark.asyncio
    async def test_zero_qualifying_tracks_makes_zero_llm_calls(self):
        state = _base_state(metric_tracks={
            "nps": {"eligible": False}, "csat": {"eligible": False}, "ces": {"eligible": False},
        })
        with patch("crystalos.lib.openrouter.call_agent", new=AsyncMock(return_value=(self._mock_output(), {}))) as mock_call:
            result = await node_narrate_tag_report(state)
        assert result["llm_call_count"] == 0
        mock_call.assert_not_called()

    @pytest.mark.asyncio
    async def test_one_qualifying_track_makes_exactly_one_llm_call(self):
        state = _base_state(metric_tracks={
            "nps": {"eligible": True, "eligible_survey_ids": ["s1"], "merged_delta": 4.0,
                    "direction": "up", "agreement_count": 1, "confidence_tier": "insufficient"},
            "csat": {"eligible": False},
        })
        with patch("crystalos.lib.openrouter.call_agent", new=AsyncMock(return_value=(self._mock_output(), {}))) as mock_call:
            result = await node_narrate_tag_report(state)
        assert result["llm_call_count"] == 1
        assert mock_call.call_count == 1
        assert "nps" in result["narrated_tracks"]

    @pytest.mark.asyncio
    async def test_two_qualifying_tracks_makes_exactly_two_llm_calls(self):
        state = _base_state(metric_tracks={
            "nps": {"eligible": True, "eligible_survey_ids": ["s1", "s2"], "merged_delta": 4.0,
                    "direction": "up", "agreement_count": 2, "confidence_tier": "confirmed"},
            "csat": {"eligible": True, "eligible_survey_ids": ["s1"], "merged_delta": 0.2,
                     "direction": "up", "agreement_count": 1, "confidence_tier": "insufficient"},
        })
        with patch("crystalos.lib.openrouter.call_agent", new=AsyncMock(return_value=(self._mock_output(), {}))) as mock_call:
            result = await node_narrate_tag_report(state)
        assert result["llm_call_count"] == 2
        assert mock_call.call_count == 2

    @pytest.mark.asyncio
    async def test_three_qualifying_tracks_makes_exactly_three_llm_calls(self):
        def track(sid):
            return {"eligible": True, "eligible_survey_ids": [sid], "merged_delta": 1.0,
                    "direction": "up", "agreement_count": 1, "confidence_tier": "insufficient"}
        state = _base_state(metric_tracks={"nps": track("s1"), "csat": track("s2"), "ces": track("s3")})
        with patch("crystalos.lib.openrouter.call_agent", new=AsyncMock(return_value=(self._mock_output(), {}))) as mock_call:
            result = await node_narrate_tag_report(state)
        assert result["llm_call_count"] == 3
        assert mock_call.call_count == 3

    @pytest.mark.asyncio
    async def test_narration_failure_is_caught_and_logged_not_raised(self):
        state = _base_state(metric_tracks={
            "nps": {"eligible": True, "eligible_survey_ids": ["s1"], "merged_delta": 4.0,
                    "direction": "up", "agreement_count": 1, "confidence_tier": "insufficient"},
        })
        with patch("crystalos.lib.openrouter.call_agent", new=AsyncMock(side_effect=RuntimeError("boom"))):
            result = await node_narrate_tag_report(state)
        assert result["llm_call_count"] == 0
        assert any("narrate_tag_report" in e for e in result["errors"])


# ── node_merge_citation_manifest ───────────────────────────────────────────────

class TestNodeMergeCitationManifest:
    @pytest.mark.asyncio
    async def test_dedupes_by_survey_and_checkpoint(self):
        ckpt = _checkpoint_row(id="c1")
        state = _base_state(
            narrated_tracks={
                "nps": {"eligible_survey_ids": ["s1"]},
                "csat": {"eligible_survey_ids": ["s1"]},  # same survey, should dedupe
            },
            boundary_checkpoints={"s1": {"single": ckpt}},
        )
        result = await node_merge_citation_manifest(state)
        assert len(result["citation_manifest"]) == 1
        assert result["citation_manifest"][0]["survey_id"] == "s1"
        assert result["citation_manifest"][0]["checkpoint_id"] == "c1"

    @pytest.mark.asyncio
    async def test_bracket_pair_yields_two_manifest_entries(self):
        start = _checkpoint_row(id="c-start")
        end = _checkpoint_row(id="c-end")
        state = _base_state(
            narrated_tracks={"nps": {"eligible_survey_ids": ["s1"]}},
            boundary_checkpoints={"s1": {"start": start, "end": end}},
        )
        result = await node_merge_citation_manifest(state)
        assert {c["checkpoint_id"] for c in result["citation_manifest"]} == {"c-start", "c-end"}


# ── _fetch_real_citations_for_checkpoint (2026-07-02 integration reconciliation) ──
# Regression coverage: the original manifest only carried citations_manifest_ref
# (a response-id INDEX with no quote text, per graphs/insights.py's
# _build_citations_manifest). Real quotes live on insights.citations_json, joined
# via the shared run_id insights and the checkpoint were both written under.

class TestFetchRealCitationsForCheckpoint:
    @pytest.mark.asyncio
    async def test_returns_empty_when_run_id_is_none(self):
        # No DB mock installed — if this didn't short-circuit on run_id=None it
        # would raise trying to open a real connection.
        result = await _fetch_real_citations_for_checkpoint("s1", None, 3)
        assert result == []

    @pytest.mark.asyncio
    async def test_resolves_real_citation_fields_from_insights_table(self):
        pool, cur, conn = _make_pool()
        cur.fetchall = AsyncMock(return_value=[
            ("insight-1", [
                {"response_id": "r1", "quote": "Loved the onboarding", "sentiment": "positive", "relevance": 0.9},
                {"response_id": "r2", "quote": "Confusing setup", "sentiment": "negative", "relevance": 0.7},
            ]),
        ])
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await _fetch_real_citations_for_checkpoint("s1", "run-abc", 3)

        assert len(result) == 2
        assert result[0] == {
            "survey_id": "s1", "response_id": "r1", "source_insight_id": "insight-1",
            "quote": "Loved the onboarding", "sentiment": "positive", "relevance": 0.9,
        }
        # Query must be scoped by BOTH run_id and survey_id, per the docstring's
        # precise-join rationale (not timestamp-proximity guessing).
        args, _ = cur.execute.await_args
        assert args[1] == ("run-abc", "s1", 3)

    @pytest.mark.asyncio
    async def test_skips_citations_missing_response_id(self):
        pool, cur, conn = _make_pool()
        cur.fetchall = AsyncMock(return_value=[
            ("insight-1", [{"quote": "no response id here", "sentiment": "neutral"}]),
        ])
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await _fetch_real_citations_for_checkpoint("s1", "run-abc", 3)
        assert result == []

    @pytest.mark.asyncio
    async def test_db_failure_returns_empty_rather_than_raising(self):
        pool, cur, conn = _make_pool()
        cur.execute = AsyncMock(side_effect=RuntimeError("connection refused"))
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await _fetch_real_citations_for_checkpoint("s1", "run-abc", 3)
        assert result == []

    @pytest.mark.asyncio
    async def test_node_merge_citation_manifest_uses_real_citations_when_available(self):
        pool, cur, conn = _make_pool()
        cur.fetchall = AsyncMock(return_value=[
            ("insight-1", [{"response_id": "r1", "quote": "Great support", "sentiment": "positive", "relevance": 0.85}]),
        ])
        ckpt = _checkpoint_row(id="c1", run_id="run-xyz")
        state = _base_state(
            narrated_tracks={"nps": {"eligible_survey_ids": ["s1"]}},
            boundary_checkpoints={"s1": {"single": ckpt}},
        )
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await node_merge_citation_manifest(state)

        assert len(result["citation_manifest"]) == 1
        entry = result["citation_manifest"][0]
        assert entry["response_id"] == "r1"
        assert entry["source_insight_id"] == "insight-1"
        assert entry["quote"] == "Great support"
        # Real-citation shape replaces the old checkpoint-only placeholder fields.
        assert "checkpoint_id" not in entry

    @pytest.mark.asyncio
    async def test_node_merge_citation_manifest_falls_back_when_no_real_citations_found(self):
        pool, cur, conn = _make_pool()
        cur.fetchall = AsyncMock(return_value=[])  # insights row exists but has no citations, or none found
        ckpt = _checkpoint_row(id="c1", run_id="run-xyz")
        state = _base_state(
            narrated_tracks={"nps": {"eligible_survey_ids": ["s1"]}},
            boundary_checkpoints={"s1": {"single": ckpt}},
        )
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await node_merge_citation_manifest(state)

        assert len(result["citation_manifest"]) == 1
        entry = result["citation_manifest"][0]
        assert entry["checkpoint_id"] == "c1"
        assert entry["survey_id"] == "s1"


# ── node_publish ────────────────────────────────────────────────────────────────

class TestNodePublish:
    @pytest.mark.asyncio
    async def test_publish_writes_one_group_insight_per_narrated_track_and_completes_run(self):
        pool, cur, conn = _make_pool()
        state = _base_state(
            narrated_tracks={"nps": {"headline": "H", "narrative": "N"}},
            metric_tracks={"nps": {"eligible_survey_ids": ["s1"], "merged_delta": 4.0,
                                    "direction": "up", "agreement_count": 2, "confidence_tier": "confirmed"}},
            included_surveys=[{"survey_id": "s1", "trend_eligible": True, "response_count": 100}],
            boundary_checkpoints={"s1": {"single": _checkpoint_row(id="c1")}},
        )
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await node_publish(state)
        assert cur.execute.await_count >= 2  # at least one INSERT group_insights + one UPDATE run
        conn.commit.assert_awaited()
        events = [e["event"] for e in result["stream_events"]]
        assert "run_complete" in events
        assert result["errors"] == []

    @pytest.mark.asyncio
    async def test_persists_single_survey_id_into_metric_json(self):
        """Regression test (2026-07-03 QA finding): single_survey_id was computed
        in merge_metric_tracks but never included in the INSERT INTO group_insights
        metric_json payload — the "name that survey" disclosure had no way to
        reach the DB/frontend at all, independent of the merge-logic bug itself."""
        pool, cur, conn = _make_pool()
        state = _base_state(
            narrated_tracks={"nps": {"headline": "H", "narrative": "N"}},
            metric_tracks={"nps": {"eligible_survey_ids": ["s1", "s2", "s3"], "merged_delta": 5.0,
                                    "direction": "up", "agreement_count": 1, "confidence_tier": "insufficient",
                                    "single_survey_id": "s1"}},
            included_surveys=[{"survey_id": sid, "trend_eligible": True, "response_count": 100} for sid in ("s1", "s2", "s3")],
            boundary_checkpoints={sid: {"single": _checkpoint_row(id=f"c-{sid}", survey_id=sid)} for sid in ("s1", "s2", "s3")},
        )
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            await node_publish(state)

        insert_call = next(
            c for c in cur.execute.await_args_list
            if c.args and "INSERT INTO group_insights" in c.args[0]
        )
        metric_json_arg = insert_call.args[1][9]  # positional params tuple, metric_json is the 10th value
        import json as _json
        assert _json.loads(metric_json_arg)["single_survey_id"] == "s1"

    @pytest.mark.asyncio
    async def test_run_complete_computes_duration_ms_from_run_started_event(self):
        """Regression test (2026-07-02 integration reconciliation): duration_ms was
        hardcoded to None; frontend's RunCompleteEvent type declares it non-nullable.
        Now computed from the run_started event's ts (always seeded first by
        run_tag_report_generation)."""
        pool, cur, conn = _make_pool()
        past_ts = (datetime.now(timezone.utc) - timedelta(seconds=2)).isoformat()
        state = _base_state(
            narrated_tracks={},
            metric_tracks={},
            included_surveys=[],
            boundary_checkpoints={},
            stream_events=[{"event": "run_started", "ts": past_ts, "run_id": "run1",
                             "tag_id": "tag1", "report_mode": "manual", "target_n": 5, "ceiling_n": 20}],
        )
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await node_publish(state)
        run_complete = next(e for e in result["stream_events"] if e["event"] == "run_complete")
        assert isinstance(run_complete["duration_ms"], (int, float))
        assert run_complete["duration_ms"] >= 1900  # ~2000ms elapsed, generous floor for test overhead

    @pytest.mark.asyncio
    async def test_run_complete_duration_ms_is_none_without_a_run_started_event(self):
        """Older/malformed state without a run_started event falls back to None
        rather than raising — defensive, not a case that should occur in practice
        now that the entry point always seeds it."""
        pool, cur, conn = _make_pool()
        state = _base_state(narrated_tracks={}, metric_tracks={}, included_surveys=[],
                             boundary_checkpoints={}, stream_events=[])
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await node_publish(state)
        run_complete = next(e for e in result["stream_events"] if e["event"] == "run_complete")
        assert run_complete["duration_ms"] is None

    @pytest.mark.asyncio
    async def test_publish_db_failure_marks_run_failed_without_raising(self):
        pool, cur, conn = _make_pool()
        cur.execute = AsyncMock(side_effect=RuntimeError("db down"))
        state = _base_state(narrated_tracks={}, metric_tracks={}, included_surveys=[], boundary_checkpoints={})
        with patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool):
            result = await node_publish(state)
        assert any("publish" in e for e in result["errors"])
        events = [e["event"] for e in result["stream_events"]]
        assert "run_failed" in events


# ── CitationRef schema — additive survey_id field ─────────────────────────────

class TestCitationRefSurveyId:
    def test_survey_id_optional_and_defaults_none(self):
        from crystalos.schemas.insight import CitationRef
        c = CitationRef(response_id="r1", quote="hello")
        assert c.survey_id is None

    def test_survey_id_can_be_set(self):
        from crystalos.schemas.insight import CitationRef
        c = CitationRef(response_id="r1", quote="hello", survey_id="s1")
        assert c.survey_id == "s1"


# ── Graph assembly ────────────────────────────────────────────────────────────

class TestBuildGraph:
    def test_graph_compiles(self):
        graph = build_tag_report_graph()
        assert graph is not None


# ── Cost invariant — the hard architectural requirement ───────────────────────

class TestCostInvariant:
    """llm_call_count == len(qualifying metric tracks), O(1)-O(3), NEVER O(N),
    across N=5/20/50 survey fixtures — TRACKER.md §2 task 15."""

    def _survey_rows(self, n: int):
        return [
            (f"s{i}", f"Survey {i}", f"2026-01-{(i % 28) + 1:02d}T00:00:00+00:00")
            for i in range(n)
        ]

    def _checkpoint_for(self, sid: str, metric_mix: str):
        """metric_mix in {'nps', 'csat', 'both'} — deterministic per-survey checkpoint."""
        nps = 40.0 if metric_mix in ("nps", "both") else None
        csat = 4.0 if metric_mix in ("csat", "both") else None
        return {
            "id": f"ckpt-{sid}", "survey_id": sid, "created_at": "2026-06-01T00:00:00+00:00",
            "response_count_at_checkpoint": 100, "nps_at_checkpoint": nps, "csat_at_checkpoint": csat,
            "ces_at_checkpoint": None, "delta_from_prior": {"nps_delta": 4.0, "csat_delta": 0.2, "ces_delta": None},
            "citations_manifest_ref": None,
        }

    @pytest.mark.parametrize("n_surveys", [5, 20, 50])
    @pytest.mark.asyncio
    async def test_llm_call_count_bounded_regardless_of_n(self, n_surveys):
        survey_rows = self._survey_rows(n_surveys)
        pool_for_fetch, _, _ = _make_pool(fetchall_return=survey_rows,
                                           description=[("id",), ("title",), ("created_at",)])
        publish_pool, publish_cur, publish_conn = _make_pool()

        checkpoints = {row[0]: self._checkpoint_for(row[0], "both") for row in survey_rows}

        async def fake_resolve(survey_id, org_id, report_mode, window_start, window_end):
            return {"single": checkpoints.get(survey_id)}

        mock_output = MagicMock()
        mock_output.headline = "Headline"
        mock_output.narrative = "Narrative."

        # Route db calls: fetch_next_batch / publish use db._pool_conn; checkpoint
        # resolution is patched directly via resolve_boundary_checkpoints so this
        # test doesn't need to fan out per-survey DB mocks for N=50.
        def _pool_router():
            return pool_for_fetch

        with (
            patch("crystalos.graphs.tag_report.db._pool_conn", side_effect=[pool_for_fetch] + [publish_pool] * 20),
            patch("crystalos.graphs.tag_report.resolve_boundary_checkpoints", new=AsyncMock(side_effect=fake_resolve)),
            patch("crystalos.lib.openrouter.call_agent", new=AsyncMock(return_value=(mock_output, {}))) as mock_call,
        ):
            await run_tag_report_generation(
                run_id="run1", org_id="org1", tag_id="tag1", report_mode="manual",
                target_n=5, ceiling_n=20, batch_size=5,
            )

        # NPS + CSAT both qualify (every survey has both metrics) -> exactly 2 calls,
        # never proportional to n_surveys.
        assert mock_call.call_count == 2
        assert mock_call.call_count <= 3


# ── run_tag_report_generation — top-level entry point ─────────────────────────

class TestRunTagReportGeneration:
    @pytest.mark.asyncio
    async def test_fatal_error_marks_run_failed(self):
        pool, cur, conn = _make_pool()
        with (
            patch("crystalos.graphs.tag_report._get_graph", side_effect=RuntimeError("graph exploded")),
            patch("crystalos.graphs.tag_report.db._pool_conn", return_value=pool),
        ):
            await run_tag_report_generation(run_id="run1", org_id="org1", tag_id="tag1")
        cur.execute.assert_awaited()
        args, _ = cur.execute.await_args
        assert "status = 'failed'" in args[0]

    @pytest.mark.asyncio
    async def test_seeds_run_started_event_before_invoking_graph(self):
        """Regression test (2026-07-02 integration reconciliation): TRACKER.md §2's
        streaming event contract lists run_started as the first event, carrying
        target_n/ceiling_n — the frontend's progress reducer reads those fields
        exclusively off this event. No node ever emitted it; this asserts the
        entry point seeds it into stream_events before graph.ainvoke runs."""
        fake_graph = MagicMock()
        fake_graph.ainvoke = AsyncMock(return_value=None)
        with patch("crystalos.graphs.tag_report._get_graph", return_value=fake_graph):
            await run_tag_report_generation(
                run_id="run1", org_id="org1", tag_id="tag1", report_mode="custom_range",
                target_n=7, ceiling_n=15,
            )
        fake_graph.ainvoke.assert_awaited_once()
        (initial_state, _config), _ = fake_graph.ainvoke.await_args
        assert len(initial_state["stream_events"]) == 1
        seeded = initial_state["stream_events"][0]
        assert seeded["event"] == "run_started"
        assert seeded["run_id"] == "run1"
        assert seeded["tag_id"] == "tag1"
        assert seeded["report_mode"] == "custom_range"
        assert seeded["target_n"] == 7
        assert seeded["ceiling_n"] == 15
        assert "ts" in seeded
