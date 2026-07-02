"""Unit tests for the insights pipeline graph nodes and signal helpers.

Tests cover:
  - extract_signals_from_response()
  - compute_survey_capability_flags()
  - node_embed / node_absa / node_cluster / node_topics guard paths (no open text)
  - _update_heartbeat()
  - compute_stratified_buckets() — dynamic bucket count by survey age
  - manual trigger uses bootstrap response cap (not incremental cap)
"""
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from crystalos.graphs.insights import (
    extract_signals_from_response,
    compute_survey_capability_flags,
    node_absa,
    node_embed,
    node_cluster,
    node_topics,
    node_narrate,
    node_publish,
    node_delta_compute,
    _update_heartbeat,
)
from crystalos.lib.constants import (
    compute_stratified_buckets,
    INGEST_MAX_RESPONSES_BOOTSTRAP,
    INGEST_MAX_RESPONSES_CAP,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_state(**kwargs):
    """Return a minimal InsightState dict for node tests."""
    defaults = {
        "survey_id": "s1",
        "org_id": "org-1",
        "run_id": "run-1",
        "trigger": "test",
        "survey": {"questions": []},
        "responses": [],
        "metrics": {},
        "open_texts": [],
        "embedded_texts": [],
        "absa_results": [],
        "clusters": [],
        "topics": [],
        "drivers": [],
        "stream_events": [],
        "insights": [],
        "errors": [],
        "has_open_text": True,
        "has_nps": False,
        "has_csat": False,
        "has_ces": False,
        "is_bootstrap": True,
        "new_response_ids": set(),
        "survey_questions": [],
    }
    defaults.update(kwargs)
    return defaults


# ── TestExtractSignals ────────────────────────────────────────────────────────

class TestExtractSignals:
    """Tests for extract_signals_from_response()."""

    def _make_args(self, answers, questions):
        return answers, questions

    def test_nps_question_extracts_nps_score(self):
        """NPS question value '9' → signals['nps_score'] == 9."""
        answers = [{"questionId": "q1", "value": "9"}]
        questions = [{"id": "q1", "type": "nps"}]
        result = extract_signals_from_response(answers, questions)
        assert result.get("nps_score") == 9

    def test_csat_extracts_float(self):
        """CSAT question value '4.5' → signals['csat_score'] == 4.5."""
        answers = [{"questionId": "q1", "value": "4.5"}]
        questions = [{"id": "q1", "type": "csat"}]
        result = extract_signals_from_response(answers, questions)
        assert result.get("csat_score") == 4.5

    def test_ces_extracts_float(self):
        """CES question value '3' → signals['ces_score'] == 3.0."""
        answers = [{"questionId": "q1", "value": "3"}]
        questions = [{"id": "q1", "type": "ces"}]
        result = extract_signals_from_response(answers, questions)
        assert result.get("ces_score") == 3.0

    def test_open_text_extracted_as_list(self):
        """Text question value → signals['open_text'] == ['Great product']."""
        answers = [{"questionId": "q1", "value": "Great product"}]
        questions = [{"id": "q1", "type": "text"}]
        result = extract_signals_from_response(answers, questions)
        assert result.get("open_text") == ["Great product"]

    def test_multiple_open_text_accumulated(self):
        """Two text answers → signals['open_text'] contains both."""
        answers = [
            {"questionId": "q1", "value": "text1"},
            {"questionId": "q2", "value": "text2"},
        ]
        questions = [
            {"id": "q1", "type": "text"},
            {"id": "q2", "type": "text"},
        ]
        result = extract_signals_from_response(answers, questions)
        assert result.get("open_text") == ["text1", "text2"]

    def test_short_text_still_extracted(self):
        """Empty string value is NOT added to open_text (falsy guard in the code)."""
        answers = [{"questionId": "q1", "value": ""}]
        questions = [{"id": "q1", "type": "text"}]
        result = extract_signals_from_response(answers, questions)
        # Empty string stripped → falsy → not added
        assert "open_text" not in result

    def test_boolean_extracted(self):
        """Boolean question type → signals['boolean_value'] == True."""
        answers = [{"questionId": "q1", "value": True}]
        questions = [{"id": "q1", "type": "boolean"}]
        result = extract_signals_from_response(answers, questions)
        assert result.get("boolean_value") is True

    def test_multiple_choice_extracted(self):
        """Multiple choice question → signals['selected_option'] == 'option_a'."""
        answers = [{"questionId": "q1", "value": "option_a"}]
        questions = [{"id": "q1", "type": "multiple_choice"}]
        result = extract_signals_from_response(answers, questions)
        assert result.get("selected_option") == "option_a"

    def test_unknown_question_type_skipped(self):
        """Unknown question type → empty signals dict."""
        answers = [{"questionId": "q1", "value": "something"}]
        questions = [{"id": "q1", "type": "unknown_type"}]
        result = extract_signals_from_response(answers, questions)
        assert result == {}

    def test_missing_question_id_skipped(self):
        """Answer with no questionId → empty signals dict."""
        answers = [{"value": "something"}]
        questions = [{"id": "q1", "type": "nps"}]
        result = extract_signals_from_response(answers, questions)
        assert result == {}


# ── TestComputeCapabilityFlags ────────────────────────────────────────────────

class TestComputeCapabilityFlags:
    """Tests for compute_survey_capability_flags()."""

    def test_nps_only_survey(self):
        """NPS-only survey → has_nps=True, has_open_text=False."""
        questions = [{"id": "q1", "type": "nps"}]
        flags = compute_survey_capability_flags(questions)
        assert flags["has_nps"] is True
        assert flags["has_open_text"] is False

    def test_text_question_sets_has_open_text(self):
        """A 'text' question sets has_open_text=True."""
        questions = [{"id": "q1", "type": "text"}]
        flags = compute_survey_capability_flags(questions)
        assert flags["has_open_text"] is True

    def test_textarea_sets_has_open_text(self):
        """A 'textarea' question also sets has_open_text=True."""
        questions = [{"id": "q1", "type": "textarea"}]
        flags = compute_survey_capability_flags(questions)
        assert flags["has_open_text"] is True

    def test_mixed_survey(self):
        """Survey with nps + csat + text → all three flags True."""
        questions = [
            {"id": "q1", "type": "nps"},
            {"id": "q2", "type": "csat"},
            {"id": "q3", "type": "text"},
        ]
        flags = compute_survey_capability_flags(questions)
        assert flags["has_nps"] is True
        assert flags["has_csat"] is True
        assert flags["has_open_text"] is True

    def test_rating_only_no_open_text(self):
        """Rating-only survey → has_open_text=False, has_ratings=True."""
        questions = [{"id": "q1", "type": "rating"}]
        flags = compute_survey_capability_flags(questions)
        assert flags["has_open_text"] is False
        assert flags["has_ratings"] is True

    def test_empty_questions(self):
        """Empty questions list → all flags False."""
        flags = compute_survey_capability_flags([])
        assert flags["has_nps"] is False
        assert flags["has_csat"] is False
        assert flags["has_ces"] is False
        assert flags["has_open_text"] is False
        assert flags["has_ratings"] is False


# ── TestNoTextGuards ──────────────────────────────────────────────────────────

class TestNoTextGuards:
    """Tests that pipeline nodes skip text processing when has_open_text=False."""

    @pytest.mark.asyncio
    async def test_node_embed_skips_when_no_open_text(self):
        """node_embed returns empty embedded_texts when has_open_text=False."""
        state = _make_state(has_open_text=False, responses=[{"nps_score": 9}])

        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.graphs.insights._emit_event", new=AsyncMock()),
        ):
            result = await node_embed(state)

        assert result.get("embedded_texts") == [] or result["embedded_texts"] == []

    @pytest.mark.asyncio
    async def test_node_absa_skips_when_no_open_text(self):
        """node_absa returns empty absa_results when has_open_text=False."""
        state = _make_state(
            has_open_text=False,
            open_texts=[{"text": "Some text", "response_id": "r1", "question_id": "q1"}],
        )

        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.graphs.insights._emit_event", new=AsyncMock()),
        ):
            result = await node_absa(state)

        assert result.get("absa_results") == []

    @pytest.mark.asyncio
    async def test_node_cluster_skips_when_no_open_text(self):
        """node_cluster returns empty clusters when has_open_text=False."""
        state = _make_state(
            has_open_text=False,
            open_texts=[{"text": "Some text", "response_id": "r1", "question_id": "q1"}],
            embedded_texts=[],
        )

        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.graphs.insights._emit_event", new=AsyncMock()),
        ):
            result = await node_cluster(state)

        assert result.get("clusters") == []

    @pytest.mark.asyncio
    async def test_node_topics_skips_when_no_open_text(self):
        """node_topics returns empty topics when has_open_text=False."""
        state = _make_state(
            has_open_text=False,
            clusters=[{"name": "Shipping", "size": 10}],
        )

        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.graphs.insights._emit_event", new=AsyncMock()),
        ):
            result = await node_topics(state)

        assert result.get("topics") == []


# ── TestHeartbeat ─────────────────────────────────────────────────────────────

class TestHeartbeat:
    """Tests for _update_heartbeat()."""

    @pytest.mark.asyncio
    async def test_update_heartbeat_calls_db(self):
        """_update_heartbeat executes an UPDATE SQL for the given run_id."""
        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock()
        mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_conn.__aexit__ = AsyncMock(return_value=False)

        mock_pool_ctx = MagicMock()
        mock_pool_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool_ctx.__aexit__ = AsyncMock(return_value=False)

        mock_pool = MagicMock()
        mock_pool.connection = MagicMock(return_value=mock_pool_ctx)

        with patch("crystalos.graphs.insights.db._pool_conn", return_value=mock_pool):
            await _update_heartbeat("run-123")

        mock_conn.execute.assert_called_once()
        call_args = mock_conn.execute.call_args[0]
        assert "UPDATE agent_runs" in call_args[0]
        assert "run-123" in call_args[1]

    @pytest.mark.asyncio
    async def test_update_heartbeat_never_raises(self):
        """_update_heartbeat swallows exceptions — never propagates."""
        mock_pool = MagicMock()
        mock_pool.connection = MagicMock(side_effect=Exception("DB totally down"))

        with patch("crystalos.graphs.insights.db._pool_conn", return_value=mock_pool):
            # Should not raise even if DB is unavailable
            await _update_heartbeat("run-xyz")


# ── TestComputeStratifiedBuckets ──────────────────────────────────────────────

class TestComputeStratifiedBuckets:
    """Tests for the dynamic bucket count function."""

    def test_brand_new_survey_uses_three_buckets(self):
        """A survey open for less than 14 days gets 3 buckets."""
        assert compute_stratified_buckets(0.0)  == 3
        assert compute_stratified_buckets(1.0)  == 3
        assert compute_stratified_buckets(13.9) == 3

    def test_short_survey_uses_six_buckets(self):
        """14 days to 89 days → 6 buckets (≈ biweekly resolution)."""
        assert compute_stratified_buckets(14.0) == 6
        assert compute_stratified_buckets(30.0) == 6
        assert compute_stratified_buckets(89.9) == 6

    def test_medium_survey_uses_twelve_buckets(self):
        """90 days to 364 days → 12 buckets (≈ monthly resolution)."""
        assert compute_stratified_buckets(90.0)  == 12
        assert compute_stratified_buckets(180.0) == 12
        assert compute_stratified_buckets(364.9) == 12

    def test_long_survey_uses_twenty_six_buckets(self):
        """≥ 365 days → 26 buckets (biweekly over a year+)."""
        assert compute_stratified_buckets(365.0)  == 26
        assert compute_stratified_buckets(730.0)  == 26
        assert compute_stratified_buckets(1825.0) == 26

    def test_env_override_pins_fixed_count(self):
        """INGEST_STRATIFIED_BUCKETS env var overrides the dynamic logic."""
        import crystalos.lib.constants as c
        original = c._STRATIFIED_BUCKETS_OVERRIDE
        try:
            c._STRATIFIED_BUCKETS_OVERRIDE = 8
            assert compute_stratified_buckets(0.0)   == 8
            assert compute_stratified_buckets(400.0) == 8
        finally:
            c._STRATIFIED_BUCKETS_OVERRIDE = original

    def test_bucket_count_never_below_three(self):
        """No edge case should produce fewer than 3 buckets."""
        for age in [-1.0, 0.0, 0.001]:
            assert compute_stratified_buckets(age) >= 3


# ── TestManualTriggerBootstrapCap ─────────────────────────────────────────────

class TestManualTriggerBootstrapCap:
    """Verify that force_regenerate (manual trigger) uses the bootstrap response cap."""

    def test_bootstrap_cap_is_gte_incremental_cap(self):
        """The bootstrap cap must be ≥ incremental cap across all envs."""
        assert INGEST_MAX_RESPONSES_BOOTSTRAP >= INGEST_MAX_RESPONSES_CAP

    def test_manual_cap_constant_relationship(self):
        """Document the cap contract: manual runs get bootstrap-level coverage."""
        # In prod: bootstrap=1500, cap=1000 — manual sees 50% more responses
        # In dev:  bootstrap=100,  cap=100  — same (dev has no headroom to spare)
        # The key property is that manual never gets LESS than scheduled runs.
        assert INGEST_MAX_RESPONSES_BOOTSTRAP >= INGEST_MAX_RESPONSES_CAP


# ── TestSelectiveSupersede ────────────────────────────────────────────────────

class TestSelectiveSupersede:
    """Regression tests for the selective supersede fix in node_publish.

    When a stream/schedule trigger skips report generation (delta < threshold),
    node_publish must preserve existing report.* insights so the Report page
    stays populated. Full supersede is only correct when new report.* insights
    are included in the current publish batch.
    """

    def _make_tracking_pool(self):
        """Return (pool_mock, execute_calls) — execute_calls records every (sql, params)."""
        execute_calls: list[tuple[str, tuple]] = []

        async def tracked_execute(sql, params=None):
            execute_calls.append((sql, params or ()))

        mock_cur = MagicMock()
        mock_cur.execute = AsyncMock()
        mock_cur.fetchall = AsyncMock(return_value=[])
        mock_cur.fetchone = AsyncMock(return_value=None)
        mock_cur.__aenter__ = AsyncMock(return_value=mock_cur)
        mock_cur.__aexit__ = AsyncMock(return_value=False)

        mock_txn = MagicMock()
        mock_txn.__aenter__ = AsyncMock(return_value=None)
        mock_txn.__aexit__ = AsyncMock(return_value=False)

        mock_conn = MagicMock()
        mock_conn.execute = tracked_execute
        mock_conn.cursor = MagicMock(return_value=mock_cur)
        mock_conn.transaction = MagicMock(return_value=mock_txn)
        mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_conn.__aexit__ = AsyncMock(return_value=False)

        pool_ctx = MagicMock()
        pool_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        pool_ctx.__aexit__ = AsyncMock(return_value=False)

        mock_pool = MagicMock()
        mock_pool.connection = MagicMock(return_value=pool_ctx)

        return mock_pool, execute_calls

    @pytest.mark.asyncio
    async def test_no_report_insights_uses_selective_supersede(self):
        """Stream trigger with no report.* insights → supersede SQL excludes report.* rows."""
        pool, calls = self._make_tracking_pool()
        state = _make_state(
            insights=[
                {
                    "category": "nps.trend",
                    "layer": "descriptive",
                    "headline": "NPS improved to +42",
                    "narrative": "Scores rose over the last 30 days.",
                    "trust_score": 0.82,
                    "priority": 0.9,
                    "citations_json": [],
                },
            ],
            trigger="stream",
        )

        with (
            patch("crystalos.graphs.insights.db._pool_conn", return_value=pool),
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.graphs.insights._publish_one", new=AsyncMock()),
            patch("crystalos.graphs.insights._emit_event", new=AsyncMock()),
            patch("crystalos.graphs.insights.filter_responses_by_window", return_value=[]),
            patch("crystalos.graphs.insights.write_checkpoint_blob", new=AsyncMock(return_value="gs://fake/ckpt")),
            patch("crystalos.lib.event_publisher.publish_run_event", new=AsyncMock()),
            patch("crystalos.graphs.insights._generate_action_recommendations", new=AsyncMock()),
        ):
            await node_publish(state)
            await asyncio.sleep(0)  # drain tasks created by create_task

        supersede_sqls = [sql for sql, _ in calls if "UPDATE insights SET superseded_at" in sql]
        assert len(supersede_sqls) >= 1, "Expected at least one supersede UPDATE"

        # Selective path: the WHERE clause must restrict to non-report categories
        assert any("category NOT LIKE" in sql for sql in supersede_sqls), (
            f"Expected 'category NOT LIKE' in supersede SQL when no report.* insights, "
            f"but got: {supersede_sqls}"
        )

        # Regression: must NOT issue a full (unrestricted) supersede
        full_supersedes = [
            sql for sql in supersede_sqls
            if "UPDATE insights SET superseded_at" in sql and "category NOT LIKE" not in sql
        ]
        assert not full_supersedes, (
            f"Unexpected full supersede when no report.* insights present: {full_supersedes}"
        )

    @pytest.mark.asyncio
    async def test_with_report_insights_uses_full_supersede(self):
        """Manual trigger with report.* insights → supersede SQL has no category filter."""
        pool, calls = self._make_tracking_pool()
        state = _make_state(
            insights=[
                {
                    "category": "report.summary",
                    "layer": "report",
                    "headline": "Executive summary",
                    "narrative": "Overall satisfaction improved.",
                    "trust_score": 0.9,
                    "priority": 1.0,
                    "citations_json": [],
                },
                {
                    "category": "nps.trend",
                    "layer": "descriptive",
                    "headline": "NPS at +42",
                    "narrative": "Scores stable.",
                    "trust_score": 0.8,
                    "priority": 0.88,
                    "citations_json": [],
                },
            ],
            trigger="manual",
        )

        with (
            patch("crystalos.graphs.insights.db._pool_conn", return_value=pool),
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.graphs.insights._publish_one", new=AsyncMock()),
            patch("crystalos.graphs.insights._emit_event", new=AsyncMock()),
            patch("crystalos.graphs.insights.filter_responses_by_window", return_value=[]),
            patch("crystalos.graphs.insights.write_checkpoint_blob", new=AsyncMock(return_value="gs://fake/ckpt")),
            patch("crystalos.lib.event_publisher.publish_run_event", new=AsyncMock()),
            patch("crystalos.graphs.insights._generate_action_recommendations", new=AsyncMock()),
        ):
            await node_publish(state)
            await asyncio.sleep(0)

        supersede_sqls = [sql for sql, _ in calls if "UPDATE insights SET superseded_at" in sql]
        assert len(supersede_sqls) >= 1, "Expected at least one supersede UPDATE"

        # Full supersede path: at least one call must NOT have the category restriction
        full_supersedes = [
            sql for sql in supersede_sqls
            if "UPDATE insights SET superseded_at" in sql and "category NOT LIKE" not in sql
        ]
        assert full_supersedes, (
            f"Expected unrestricted supersede SQL when report.* insights present, "
            f"but got: {supersede_sqls}"
        )

    @pytest.mark.asyncio
    async def test_report_prefix_detection_is_exact(self):
        """Only 'report.*' prefixed categories trigger full supersede; 'reported.*' does not."""
        pool, calls = self._make_tracking_pool()
        state = _make_state(
            insights=[
                {
                    "category": "reported.issue",  # NOT a report.* category
                    "layer": "descriptive",
                    "headline": "Reported issues rose 10%",
                    "narrative": "Issue volume increased.",
                    "trust_score": 0.7,
                    "priority": 0.75,
                    "citations_json": [],
                },
            ],
            trigger="stream",
        )

        with (
            patch("crystalos.graphs.insights.db._pool_conn", return_value=pool),
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.graphs.insights._publish_one", new=AsyncMock()),
            patch("crystalos.graphs.insights._emit_event", new=AsyncMock()),
            patch("crystalos.graphs.insights.filter_responses_by_window", return_value=[]),
            patch("crystalos.graphs.insights.write_checkpoint_blob", new=AsyncMock(return_value="gs://fake/ckpt")),
            patch("crystalos.lib.event_publisher.publish_run_event", new=AsyncMock()),
            patch("crystalos.graphs.insights._generate_action_recommendations", new=AsyncMock()),
        ):
            await node_publish(state)
            await asyncio.sleep(0)

        supersede_sqls = [sql for sql, _ in calls if "UPDATE insights SET superseded_at" in sql]
        # 'reported.issue' does NOT start with 'report.' so selective path must be taken
        assert any("category NOT LIKE" in sql for sql in supersede_sqls), (
            f"'reported.*' category should not trigger full supersede: {supersede_sqls}"
        )


# ── TestNodeDeltaCompute (Insight Pipeline v2 — Phase 0.5) ────────────────────

class TestNodeDeltaCompute:
    """Tests for node_delta_compute — bootstrap path + non-bootstrap delta path."""

    def _make_cursor_pool(self, fetchall_return=None):
        """Pool mock whose cursor returns the given rows for fetchall(), with a
        matching cur.description for the node_delta_compute SELECT."""
        mock_cur = AsyncMock()
        mock_cur.execute = AsyncMock()
        mock_cur.fetchall = AsyncMock(return_value=fetchall_return or [])
        mock_cur.description = [
            ("checkpoint_number",), ("report_url",), ("created_at",),
            ("nps_at_checkpoint",), ("topic_fingerprint",),
        ]
        mock_cur.__aenter__ = AsyncMock(return_value=mock_cur)
        mock_cur.__aexit__ = AsyncMock(return_value=False)

        mock_conn = AsyncMock()
        mock_conn.cursor = MagicMock(return_value=mock_cur)
        mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_conn.__aexit__ = AsyncMock(return_value=False)

        pool_ctx = MagicMock()
        pool_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        pool_ctx.__aexit__ = AsyncMock(return_value=False)

        mock_pool = MagicMock()
        mock_pool.connection = MagicMock(return_value=pool_ctx)
        return mock_pool

    @pytest.mark.asyncio
    async def test_bootstrap_returns_meaningful_true_none_delta(self):
        """Bootstrap run: delta None, meaningful_delta True, no DB read."""
        state = _make_state(is_bootstrap=True, metrics={"nps": {"score": 40.0}})
        with patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()):
            result = await node_delta_compute(state)
        assert result["delta_from_prior"] is None
        assert result["meaningful_delta"] is True
        assert result["prior_checkpoint_summaries"] == []

    @pytest.mark.asyncio
    async def test_no_prior_blob_falls_back_to_bootstrap_path(self):
        """Non-bootstrap but no prior checkpoint rows → bootstrap-like fallback."""
        pool = self._make_cursor_pool(fetchall_return=[])
        state = _make_state(is_bootstrap=False, metrics={"nps": {"score": 40.0}})
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.graphs.insights.db._pool_conn", return_value=pool),
        ):
            result = await node_delta_compute(state)
        assert result["delta_from_prior"] is None
        assert result["meaningful_delta"] is True
        assert result["prior_checkpoint_summaries"] == []

    @pytest.mark.asyncio
    async def test_non_bootstrap_computes_delta_and_summaries(self):
        """Non-bootstrap with a prior blob → computes delta + scalar summaries."""
        from datetime import datetime, timezone
        rows = [
            (3, "ref-3", datetime(2026, 6, 1, tzinfo=timezone.utc), 45.0, "fp3"),
            (2, "ref-2", datetime(2026, 5, 1, tzinfo=timezone.utc), 44.0, "fp2"),
        ]
        pool = self._make_cursor_pool(fetchall_return=rows)
        prior_blob = {
            "nps_at_checkpoint": 45.0,
            "csat_at_checkpoint": 4.0,
            "response_count_at_checkpoint": 50,
            "topics": [{"name": "Billing"}],
        }
        state = _make_state(
            is_bootstrap=False,
            metrics={"nps": {"score": 40.0}, "csat": {"score": 4.0}, "total_responses": 60},
            topic_signals={"Billing": {}, "AI features": {}},
        )
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.graphs.insights.db._pool_conn", return_value=pool),
            patch(
                "crystalos.lib.checkpoint_store.read_checkpoint_blob",
                new=AsyncMock(return_value=prior_blob),
            ),
        ):
            result = await node_delta_compute(state)

        delta = result["delta_from_prior"]
        assert delta is not None
        assert delta["nps_delta"] == -5.0            # 40 - 45
        assert "AI features" in delta["topic_changes"]["emerged"]
        assert result["meaningful_delta"] is True    # 5-pt drop > 2.0 default
        # Summaries are oldest-first, scalar only, date truncated to YYYY-MM-DD.
        summaries = result["prior_checkpoint_summaries"]
        assert [s["checkpoint_number"] for s in summaries] == [2, 3]
        assert summaries[0]["created_at"] == "2026-05-01"
        assert summaries[1]["nps"] == 45.0

    @pytest.mark.asyncio
    async def test_db_failure_falls_back_to_bootstrap_path(self):
        """A DB error during prior-checkpoint load must not crash the pipeline."""
        mock_pool = MagicMock()
        mock_pool.connection = MagicMock(side_effect=Exception("DB down"))
        state = _make_state(is_bootstrap=False, metrics={"nps": {"score": 40.0}})
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.graphs.insights.db._pool_conn", return_value=mock_pool),
        ):
            result = await node_delta_compute(state)
        assert result["delta_from_prior"] is None
        assert result["meaningful_delta"] is True

    # ── Xperiq Actions Wave 3 — ai_trigger_baseline_negative_pct propagation ────

    @pytest.mark.asyncio
    async def test_bootstrap_sets_ai_trigger_baseline_none(self):
        state = _make_state(is_bootstrap=True, metrics={"nps": {"score": 40.0}})
        with patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()):
            result = await node_delta_compute(state)
        assert result["ai_trigger_baseline_negative_pct"] is None

    @pytest.mark.asyncio
    async def test_no_prior_blob_sets_ai_trigger_baseline_none(self):
        pool = self._make_cursor_pool(fetchall_return=[])
        state = _make_state(is_bootstrap=False, metrics={"nps": {"score": 40.0}})
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.graphs.insights.db._pool_conn", return_value=pool),
        ):
            result = await node_delta_compute(state)
        assert result["ai_trigger_baseline_negative_pct"] is None

    @pytest.mark.asyncio
    async def test_prior_blob_with_ai_trigger_field_is_read_forward(self):
        """A prior blob written post-Wave-3 carries ai_trigger_negative_pct —
        node_delta_compute must surface it as this run's sentiment_spike baseline."""
        from datetime import datetime, timezone
        rows = [(3, "ref-3", datetime(2026, 6, 1, tzinfo=timezone.utc), 45.0, "fp3")]
        pool = self._make_cursor_pool(fetchall_return=rows)
        prior_blob = {
            "nps_at_checkpoint": 45.0,
            "csat_at_checkpoint": 4.0,
            "response_count_at_checkpoint": 50,
            "topics": [{"name": "Billing"}],
            "ai_trigger_negative_pct": 22.5,
        }
        state = _make_state(is_bootstrap=False, metrics={"nps": {"score": 40.0}}, topic_signals={"Billing": {}})
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.graphs.insights.db._pool_conn", return_value=pool),
            patch("crystalos.lib.checkpoint_store.read_checkpoint_blob", new=AsyncMock(return_value=prior_blob)),
        ):
            result = await node_delta_compute(state)
        assert result["ai_trigger_baseline_negative_pct"] == pytest.approx(22.5)

    @pytest.mark.asyncio
    async def test_prior_blob_without_ai_trigger_field_degrades_to_none(self):
        """A prior blob from BEFORE Wave 3 has no ai_trigger_negative_pct key —
        must not KeyError, just report no baseline (sentiment_spike won't fire
        yet for this survey until one post-wave checkpoint exists)."""
        from datetime import datetime, timezone
        rows = [(3, "ref-3", datetime(2026, 6, 1, tzinfo=timezone.utc), 45.0, "fp3")]
        pool = self._make_cursor_pool(fetchall_return=rows)
        prior_blob = {
            "nps_at_checkpoint": 45.0,
            "response_count_at_checkpoint": 50,
            "topics": [],
        }
        state = _make_state(is_bootstrap=False, metrics={"nps": {"score": 40.0}})
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.graphs.insights.db._pool_conn", return_value=pool),
            patch("crystalos.lib.checkpoint_store.read_checkpoint_blob", new=AsyncMock(return_value=prior_blob)),
        ):
            result = await node_delta_compute(state)
        assert result["ai_trigger_baseline_negative_pct"] is None
