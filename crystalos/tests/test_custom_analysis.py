"""Tests for the isolated Custom Analysis graph + Phase 7 retention job.

Covers (per task spec):
  - filter_spec application (date / segment / topic)
  - ISOLATION: run_custom_analysis NEVER writes the insights table (mock + assert)
  - trust_score cap at 55 when n < custom_analysis_min_n_for_nps
  - slug / status updates on custom_reports
  - retention job: idempotent, gated, only touches low-delta automated rows

Mock rules (CLAUDE.md): AsyncMock for async; never make real LLM/DB calls.
"""
import json
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from crystalos.graphs.custom_analysis import (
    apply_filter_spec, _resolve_credit_cost_for_corpus, _cap_trust,
    _build_custom_insights, _filter_label, run_custom_analysis,
)


# ── Pure: filter_spec application ──────────────────────────────────────────────

class TestApplyFilterSpec:
    def _rows(self):
        base = datetime(2026, 6, 1, tzinfo=timezone.utc)
        return [
            {"id": "r1", "submitted_at": base + timedelta(days=1),
             "answers": [{"questionId": "seg", "value": "Enterprise"}], "ai_topics": ["Billing"]},
            {"id": "r2", "submitted_at": base + timedelta(days=10),
             "answers": [{"questionId": "seg", "value": "SMB"}], "ai_topics": ["Login"]},
            {"id": "r3", "submitted_at": base + timedelta(days=40),
             "answers": [{"questionId": "seg", "value": "Enterprise"}], "ai_topics": ["Onboarding"]},
        ]

    def test_no_spec_returns_all(self):
        rows = self._rows()
        assert len(apply_filter_spec(rows, {})) == 3

    def test_date_window_filters(self):
        rows = self._rows()
        spec = {"date_from": "2026-06-05T00:00:00Z", "date_to": "2026-06-20T00:00:00Z"}
        out = apply_filter_spec(rows, spec)
        assert [r["id"] for r in out] == ["r2"]

    def test_segment_eq_filters(self):
        rows = self._rows()
        spec = {"segments": [{"field": "seg", "op": "eq", "value": "Enterprise"}]}
        out = apply_filter_spec(rows, spec)
        assert {r["id"] for r in out} == {"r1", "r3"}

    def test_topic_filter(self):
        rows = self._rows()
        out = apply_filter_spec(rows, {"topics": ["Billing"]})
        assert [r["id"] for r in out] == ["r1"]

    def test_combined_segment_and_date(self):
        rows = self._rows()
        spec = {
            "segments": [{"field": "seg", "op": "eq", "value": "Enterprise"}],
            "date_from": "2026-06-20T00:00:00Z",
        }
        out = apply_filter_spec(rows, spec)
        assert [r["id"] for r in out] == ["r3"]


# ── Pure: credit tier + trust cap + label ──────────────────────────────────────

class TestCustomHelpers:
    def test_credit_cost_tiers(self):
        assert _resolve_credit_cost_for_corpus(300) == 25
        assert _resolve_credit_cost_for_corpus(1500) == 50
        assert _resolve_credit_cost_for_corpus(5000) == 75

    def test_trust_cap_below_min(self):
        assert _cap_trust(90, below_min_n=True) == 55
        assert _cap_trust(40, below_min_n=True) == 40   # already below cap
        assert _cap_trust(90, below_min_n=False) == 90

    def test_filter_label(self):
        label = _filter_label({"segments": [{"value": "Enterprise"}], "topics": ["Billing"]})
        assert "Enterprise" in label and "Billing" in label


# ── Insight builder: trust cap + NO predictive layer ───────────────────────────

class TestBuildCustomInsights:
    def test_caps_trust_when_below_min_n(self):
        metrics = {"nps": {"score": 41.0, "n": 12}, "total_responses": 12}
        insights = _build_custom_insights(metrics, topics=[], sample_size=12,
                                          below_min_n=True, label="Enterprise")
        nps = next(i for i in insights if i["category"] == "metric.nps")
        assert nps["trust_score"] <= 55

    def test_full_trust_when_above_min_n(self):
        metrics = {"nps": {"score": 41.0, "n": 120}, "total_responses": 120}
        insights = _build_custom_insights(metrics, topics=[], sample_size=120,
                                          below_min_n=False, label="All")
        nps = next(i for i in insights if i["category"] == "metric.nps")
        assert nps["trust_score"] > 55

    def test_no_predictive_layer(self):
        metrics = {"nps": {"score": 41.0, "n": 120}, "total_responses": 120}
        topics = [{"name": "Billing", "volume": 10, "sentiment_score": -0.4, "summary": "s"}]
        insights = _build_custom_insights(metrics, topics, sample_size=120,
                                          below_min_n=False, label="All")
        assert all(i["layer"] != "predictive" for i in insights)
        assert {i["layer"] for i in insights} <= {"descriptive", "diagnostic"}


# ── Isolation: run_custom_analysis never writes insights / supersede / centroids ─

class TestCustomAnalysisIsolation:
    """The hard invariants (03 §11): no insights-table write, no supersede, no
    survey_topics centroid mutation."""

    def _make_mock_pool(self, executed_sql: list):
        """Mock pool that records every SQL string passed to execute()."""
        def _record(sql, *args, **kwargs):
            executed_sql.append(sql)
            return None

        mock_cur = AsyncMock()
        mock_cur.execute = AsyncMock(side_effect=_record)
        mock_cur.fetchone = AsyncMock(return_value=None)
        mock_cur.fetchall = AsyncMock(return_value=[])
        mock_cur.description = []
        mock_cur.__aenter__ = AsyncMock(return_value=mock_cur)
        mock_cur.__aexit__ = AsyncMock(return_value=False)

        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock(side_effect=_record)
        mock_conn.cursor = MagicMock(return_value=mock_cur)
        mock_conn.commit = AsyncMock()
        mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_conn.__aexit__ = AsyncMock(return_value=False)

        mock_pool_ctx = MagicMock()
        mock_pool_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool_ctx.__aexit__ = AsyncMock(return_value=False)
        mock_pool = MagicMock()
        mock_pool.connection = MagicMock(return_value=mock_pool_ctx)
        return mock_pool

    @pytest.mark.asyncio
    async def test_never_writes_insights_table_or_supersedes(self):
        executed: list = []
        mock_pool = self._make_mock_pool(executed)

        survey = {"id": "survey-1", "title": "Test", "questions": [{"id": "q1", "type": "nps"}]}
        corpus = [
            {"id": f"r{i}", "answers": [{"questionId": "q1", "value": 9}],
             "submitted_at": datetime.now(timezone.utc), "ai_topics": []}
            for i in range(12)
        ]

        with patch("crystalos.graphs.custom_analysis.db._pool_conn", return_value=mock_pool), \
             patch("crystalos.graphs.custom_analysis._load_survey",
                   new_callable=AsyncMock, return_value=survey), \
             patch("crystalos.graphs.custom_analysis._load_corpus",
                   new_callable=AsyncMock, return_value=corpus), \
             patch("crystalos.lib.insight_settings.load_insight_settings",
                   new_callable=AsyncMock, return_value={"custom_analysis_max_corpus": 5000,
                                                         "custom_analysis_min_n_for_nps": 30}), \
             patch("crystalos.graphs.custom_analysis.extract_open_texts", return_value=[]), \
             patch("crystalos.graphs.custom_analysis.write_checkpoint_blob",
                   new_callable=AsyncMock, return_value="blob-ref"):
            result = await run_custom_analysis(
                "survey-1", "org-1", "run-1", "cr-1",
                filter_spec={}, actor="user:abc")

        assert result["status"] == "completed"
        joined = "\n".join(executed).lower()
        # HARD INVARIANT 1: never INSERT/UPDATE the insights table.
        assert "into insights" not in joined
        assert "update insights" not in joined
        # HARD INVARIANT 2: never supersede.
        assert "superseded_at" not in joined
        # HARD INVARIANT 3: never mutate survey_topics centroids.
        assert "survey_topics" not in joined
        assert "survey_topic_centroids" not in joined
        # It SHOULD write the isolated tables.
        assert "custom_report_insights" in joined
        assert "custom_reports" in joined

    @pytest.mark.asyncio
    async def test_sets_status_and_slug_on_completion(self):
        executed: list = []
        recorded_updates: list = []
        mock_pool = self._make_mock_pool(executed)

        survey = {"id": "survey-1", "title": "Test", "questions": [{"id": "q1", "type": "nps"}]}
        corpus = [{"id": "r1", "answers": [{"questionId": "q1", "value": 9}],
                   "submitted_at": datetime.now(timezone.utc), "ai_topics": []}]

        async def _capture_update(cid, **fields):
            recorded_updates.append(fields)

        with patch("crystalos.graphs.custom_analysis.db._pool_conn", return_value=mock_pool), \
             patch("crystalos.graphs.custom_analysis._load_survey",
                   new_callable=AsyncMock, return_value=survey), \
             patch("crystalos.graphs.custom_analysis._load_corpus",
                   new_callable=AsyncMock, return_value=corpus), \
             patch("crystalos.graphs.custom_analysis._update_custom_report",
                   new=AsyncMock(side_effect=_capture_update)), \
             patch("crystalos.graphs.custom_analysis._insert_custom_insight",
                   new_callable=AsyncMock), \
             patch("crystalos.graphs.custom_analysis.extract_open_texts", return_value=[]), \
             patch("crystalos.graphs.custom_analysis.write_checkpoint_blob",
                   new_callable=AsyncMock, return_value="blob-ref"):
            result = await run_custom_analysis(
                "survey-1", "org-1", "run-1", "cr-1", filter_spec={}, actor="user:abc")

        assert result["status"] == "completed"
        assert result["slug"].startswith("cr-")
        completed = [u for u in recorded_updates if u.get("status") == "completed"]
        assert completed, recorded_updates
        assert completed[-1]["slug"] == result["slug"]
        assert "sample_size" in completed[-1]

    @pytest.mark.asyncio
    async def test_trust_capped_when_corpus_below_min_n(self):
        """n < min_n_for_nps → every persisted insight trust_score ≤ 55."""
        inserted: list = []
        executed: list = []
        mock_pool = self._make_mock_pool(executed)

        survey = {"id": "survey-1", "title": "Test", "questions": [{"id": "q1", "type": "nps"}]}
        # 5 responses → below default min_n of 30
        corpus = [{"id": f"r{i}", "answers": [{"questionId": "q1", "value": 9}],
                   "submitted_at": datetime.now(timezone.utc), "ai_topics": []} for i in range(5)]

        async def _capture_insert(crid, org, sid, ins, label):
            inserted.append(ins)

        with patch("crystalos.graphs.custom_analysis.db._pool_conn", return_value=mock_pool), \
             patch("crystalos.graphs.custom_analysis._load_survey",
                   new_callable=AsyncMock, return_value=survey), \
             patch("crystalos.graphs.custom_analysis._load_corpus",
                   new_callable=AsyncMock, return_value=corpus), \
             patch("crystalos.graphs.custom_analysis._update_custom_report",
                   new_callable=AsyncMock), \
             patch("crystalos.graphs.custom_analysis._insert_custom_insight",
                   new=AsyncMock(side_effect=_capture_insert)), \
             patch("crystalos.graphs.custom_analysis.extract_open_texts", return_value=[]), \
             patch("crystalos.graphs.custom_analysis.write_checkpoint_blob",
                   new_callable=AsyncMock, return_value="blob-ref"):
            await run_custom_analysis("survey-1", "org-1", "run-1", "cr-1",
                                      filter_spec={}, actor="user:abc")

        assert inserted, "expected at least one custom insight"
        assert all(i["trust_score"] <= 55 for i in inserted)


# ── Phase 7 retention job ──────────────────────────────────────────────────────

class TestRetentionJob:
    def _make_mock_pool(self, rows_per_call: list):
        """Mock pool where each fetchall() returns the next list in rows_per_call."""
        calls = {"i": 0}

        async def _fetchall():
            i = calls["i"]
            calls["i"] += 1
            return rows_per_call[i] if i < len(rows_per_call) else []

        mock_cur = AsyncMock()
        mock_cur.execute = AsyncMock()
        mock_cur.fetchall = AsyncMock(side_effect=_fetchall)
        mock_cur.__aenter__ = AsyncMock(return_value=mock_cur)
        mock_cur.__aexit__ = AsyncMock(return_value=False)
        mock_conn = AsyncMock()
        mock_conn.cursor = MagicMock(return_value=mock_cur)
        mock_conn.commit = AsyncMock()
        mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_conn.__aexit__ = AsyncMock(return_value=False)
        mock_pool_ctx = MagicMock()
        mock_pool_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool_ctx.__aexit__ = AsyncMock(return_value=False)
        mock_pool = MagicMock()
        mock_pool.connection = MagicMock(return_value=mock_pool_ctx)
        return mock_pool, mock_cur

    @pytest.mark.asyncio
    async def test_retention_disabled_is_noop(self):
        import crystalos.scheduler as sched
        with patch.object(sched, "ENABLE_RETENTION_JOB", False):
            result = await sched.run_retention_job()
        assert result == {"enabled": False, "collapsed": 0, "blobs_dropped": 0}

    @pytest.mark.asyncio
    async def test_retention_collapses_and_drops_blobs(self):
        import crystalos.scheduler as sched
        # First execute → collapse returns 2 rows; second → blob drop returns 1 row.
        mock_pool, mock_cur = self._make_mock_pool([[("id-1",), ("id-2",)], [("id-1",)]])
        with patch.object(sched, "ENABLE_RETENTION_JOB", True), \
             patch("crystalos.scheduler._pool_conn", return_value=mock_pool):
            result = await sched.run_retention_job()
        assert result["enabled"] is True
        assert result["collapsed"] == 2
        assert result["blobs_dropped"] == 1
        # SQL must target only automated lane + meaningful_delta=false (never manual/true).
        collapse_sql = mock_cur.execute.call_args_list[0][0][0].lower()
        assert "lane = 'automated'" in collapse_sql
        assert "meaningful_delta = false" in collapse_sql

    @pytest.mark.asyncio
    async def test_retention_idempotent_second_run_noop(self):
        """A second run finds nothing to collapse (already-collapsed rows excluded)."""
        import crystalos.scheduler as sched
        mock_pool, _ = self._make_mock_pool([[], []])
        with patch.object(sched, "ENABLE_RETENTION_JOB", True), \
             patch("crystalos.scheduler._pool_conn", return_value=mock_pool):
            result = await sched.run_retention_job()
        assert result["collapsed"] == 0
        assert result["blobs_dropped"] == 0


class TestResponseTaggingBacklogSweep:
    """run_response_tagging_backlog_sweep (added 2026-07-04) — the safety net
    for surveys not currently receiving live stream events, and for responses
    whose tagging attempt previously failed (they simply never got
    ai_enriched_at set, so this query finds them again with no extra state)."""

    def _make_mock_pool(self, rows):
        mock_cur = AsyncMock()
        mock_cur.execute = AsyncMock()
        mock_cur.fetchall = AsyncMock(return_value=rows)
        mock_cur.__aenter__ = AsyncMock(return_value=mock_cur)
        mock_cur.__aexit__ = AsyncMock(return_value=False)
        mock_conn = AsyncMock()
        mock_conn.cursor = MagicMock(return_value=mock_cur)
        mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_conn.__aexit__ = AsyncMock(return_value=False)
        mock_pool_ctx = MagicMock()
        mock_pool_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool_ctx.__aexit__ = AsyncMock(return_value=False)
        mock_pool = MagicMock()
        mock_pool.connection = MagicMock(return_value=mock_pool_ctx)
        return mock_pool, mock_cur

    @pytest.mark.asyncio
    async def test_disabled_is_noop(self):
        import crystalos.scheduler as sched
        with patch.object(sched, "ENABLE_RESPONSE_TAGGING_BACKLOG_SWEEP", False):
            result = await sched.run_response_tagging_backlog_sweep()
        assert result == {"enabled": False, "surveys_swept": 0}

    @pytest.mark.asyncio
    async def test_sweeps_every_survey_with_untagged_responses(self):
        import crystalos.scheduler as sched
        mock_pool, mock_cur = self._make_mock_pool([("s1", "o1"), ("s2", "o2")])
        tag_mock = AsyncMock(return_value={"tagged": 1})
        with (
            patch.object(sched, "ENABLE_RESPONSE_TAGGING_BACKLOG_SWEEP", True),
            patch("crystalos.scheduler._pool_conn", return_value=mock_pool),
            patch("crystalos.lib.response_tagging.tag_untagged_responses", tag_mock),
            patch("crystalos.scheduler.asyncio.sleep", new=AsyncMock()),
        ):
            result = await sched.run_response_tagging_backlog_sweep()
        assert result == {"enabled": True, "surveys_swept": 2}
        assert tag_mock.await_args_list == [call("s1", "o1"), call("s2", "o2")]
        # Query must target ai_enriched_at IS NULL — the same "untagged" contract
        # response_tagging.py itself uses (no separate failure-tracking state).
        select_sql = mock_cur.execute.call_args[0][0].lower()
        assert "ai_enriched_at is null" in select_sql

    @pytest.mark.asyncio
    async def test_no_untagged_responses_is_a_noop(self):
        import crystalos.scheduler as sched
        mock_pool, _ = self._make_mock_pool([])
        with (
            patch.object(sched, "ENABLE_RESPONSE_TAGGING_BACKLOG_SWEEP", True),
            patch("crystalos.scheduler._pool_conn", return_value=mock_pool),
        ):
            result = await sched.run_response_tagging_backlog_sweep()
        assert result == {"enabled": True, "surveys_swept": 0}

    @pytest.mark.asyncio
    async def test_one_survey_failing_does_not_block_the_rest(self):
        import crystalos.scheduler as sched
        mock_pool, _ = self._make_mock_pool([("s1", "o1"), ("s2", "o2")])
        tag_mock = AsyncMock(side_effect=[RuntimeError("boom"), {"tagged": 1}])
        with (
            patch.object(sched, "ENABLE_RESPONSE_TAGGING_BACKLOG_SWEEP", True),
            patch("crystalos.scheduler._pool_conn", return_value=mock_pool),
            patch("crystalos.lib.response_tagging.tag_untagged_responses", tag_mock),
            patch("crystalos.scheduler.asyncio.sleep", new=AsyncMock()),
        ):
            result = await sched.run_response_tagging_backlog_sweep()
        assert result["surveys_swept"] == 1
        assert tag_mock.await_count == 2
