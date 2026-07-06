"""Unit tests for lib/response_tagging.py — the lightweight per-response
sentiment/emotion/effort/topic tagging sweep (added 2026-07-04, decoupled from
the full insight pipeline in graphs/insights.py).

Mock rules (CLAUDE.md): AsyncMock for async fns; patch db._pool_conn; never call
real LLMs/DB. Sub-functions (get_or_create_embeddings, run_absa_llm, get_absa_config,
topic_registry.*) are patched directly rather than simulated via raw SQL, since
tag_untagged_responses orchestrates at that abstraction level.
"""
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from crystalos.lib.response_tagging import tag_untagged_responses, _fetch_untagged_responses


# ── Mock DB plumbing ──────────────────────────────────────────────────────────

class _RespCursor:
    """Routes execute() by SQL text: untagged-responses SELECT, survey SELECT,
    and (for older buffered candidates) the ai_sentiment/ai_emotion reconstruction
    SELECT. executemany() calls are just recorded (with optional failure injection)."""

    def __init__(self, untagged_rows=None, survey_row=("[]",), reconstruct_rows=None):
        self._untagged_rows = untagged_rows or []
        # Matches the ACTUAL responses table (supabase/migrations/20240101000000_initial.sql)
        # — id, answers only. Fixed 2026-07-05: this used to also list nps_score,
        # csat_score, ces_score, which caused a real production failure
        # ("column csat_score does not exist" — the table only ever had nps_score, and
        # none of the three were even used downstream). Mocked-cursor tests never
        # caught it because a mock doesn't validate column names against a real schema.
        self._untagged_desc = [("id",), ("answers",)]
        self._survey_row = survey_row
        self._reconstruct_rows = reconstruct_rows or []
        self._reconstruct_desc = [("id",), ("answers",), ("ai_sentiment",), ("ai_sentiment_score",), ("ai_emotion",)]
        self.description = None
        self._last_fetchall = []
        self._last_fetchone = None
        self.execute_calls = []
        self.executemany_calls = []
        self.fail_executemany_containing = None

    async def execute(self, sql, params=None):
        self.execute_calls.append((sql, params))
        if "FROM responses" in sql and "ai_enriched_at IS NULL" in sql:
            self.description = self._untagged_desc
            self._last_fetchall = list(self._untagged_rows)
        elif "FROM responses" in sql and "ai_sentiment" in sql:
            self.description = self._reconstruct_desc
            self._last_fetchall = list(self._reconstruct_rows)
        elif "FROM surveys" in sql:
            self._last_fetchone = self._survey_row

    async def executemany(self, sql, params_list):
        self.executemany_calls.append((sql, list(params_list)))
        if self.fail_executemany_containing and self.fail_executemany_containing in sql:
            raise RuntimeError("simulated writeback failure")

    async def fetchall(self):
        return self._last_fetchall

    async def fetchone(self):
        return self._last_fetchone

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _RespConn:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor

    async def commit(self):
        return None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def _pool_for(cursor):
    conn = _RespConn(cursor)
    pool = MagicMock()
    pool.connection = MagicMock(return_value=conn)
    return pool


def _open_text_survey():
    return ('[{"id": "q1", "type": "open_text", "question": "Anything else?"}]',)


def _untagged_row(rid, text="This was a genuinely great experience overall"):
    return (rid, [{"questionId": "q1", "value": text}])


_ABSA_CFG = {"batch_size": 10, "concurrency": 3, "cap": 100}


def _absa_result(rid, qid="q1", sentiment="positive", score=0.8, emotion="joy", text="great experience"):
    return {"response_id": rid, "question_id": qid, "text": text,
            "sentiment": sentiment, "score": score, "emotion": emotion}


# ── No untagged responses ─────────────────────────────────────────────────────

class TestNoUntaggedResponses:
    @pytest.mark.asyncio
    async def test_returns_early_with_zeroed_result(self):
        cur = _RespCursor(untagged_rows=[])
        with patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)):
            result = await tag_untagged_responses("s1", "o1")
        assert result == {
            "tagged": 0, "topics_assigned": 0, "topics_buffered": 0, "topics_discovered": 0,
            "skipped_no_survey": False, "failed": 0,
        }
        # No survey lookup needed if there's nothing to tag.
        assert not any("FROM surveys" in sql for sql, _ in cur.execute_calls)


# ── Survey not found ──────────────────────────────────────────────────────────

class TestSurveyNotFound:
    @pytest.mark.asyncio
    async def test_skips_when_survey_row_missing(self):
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=None)
        with patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)):
            result = await tag_untagged_responses("s1", "o1")
        assert result["skipped_no_survey"] is True
        assert result["tagged"] == 0


# ── Core sentiment/emotion/effort tagging ─────────────────────────────────────

class TestSentimentEmotionEffortTagging:
    @pytest.mark.asyncio
    async def test_tags_untagged_responses_with_sentiment_emotion_effort(self):
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.1, 0.2]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("r1")])

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=False)),
        ):
            result = await tag_untagged_responses("s1", "o1")

        assert result["tagged"] == 1
        assert result["failed"] == 0
        sentiment_calls = [c for c in cur.executemany_calls if "ai_sentiment" in c[0]]
        assert len(sentiment_calls) == 1
        _, params = sentiment_calls[0]
        dom_sentiment, avg_score, dom_emotion, effort, resp_id = params[0]
        assert resp_id == "r1"
        assert dom_sentiment == "positive"
        assert dom_emotion == "joy"
        assert avg_score == pytest.approx(0.8)

    @pytest.mark.asyncio
    async def test_default_batch_size_of_one_is_not_blocked_by_a_text_floor(self):
        """The core bug this module exists to avoid: node_absa refuses anything
        under 3 texts. A single untagged response (batch size 1, the default)
        must still get scored — no floor here."""
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.1]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("r1")])

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock) as run_mock,
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=False)),
        ):
            result = await tag_untagged_responses("s1", "o1")

        run_mock.assert_awaited_once()
        called_texts = run_mock.call_args[0][0]
        assert len(called_texts) == 1
        assert result["tagged"] == 1

    @pytest.mark.asyncio
    async def test_embed_failure_falls_back_but_still_scores_sentiment(self):
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        absa_mock = AsyncMock(return_value=[_absa_result("r1")])

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings",
                  AsyncMock(side_effect=RuntimeError("embed service down"))),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=False)),
        ):
            result = await tag_untagged_responses("s1", "o1")

        assert result["tagged"] == 1
        assert result["topics_assigned"] == 0

    @pytest.mark.asyncio
    async def test_sentiment_writeback_failure_is_caught_not_raised(self):
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        cur.fail_executemany_containing = "ai_sentiment"
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.1]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("r1")])

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=False)),
        ):
            result = await tag_untagged_responses("s1", "o1")

        assert result["tagged"] == 0
        assert result["failed"] == 1


# ── No open-text questions on the survey ──────────────────────────────────────

class TestNoOpenTextSurvey:
    @pytest.mark.asyncio
    async def test_marks_enriched_without_llm_calls(self):
        cur = _RespCursor(untagged_rows=[_untagged_row("r1"), _untagged_row("r2")], survey_row=("[]",))
        embed_mock = AsyncMock()
        absa_mock = AsyncMock()

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
        ):
            result = await tag_untagged_responses("s1", "o1")

        assert result["tagged"] == 2
        embed_mock.assert_not_called()
        absa_mock.assert_not_called()
        enrich_calls = [c for c in cur.executemany_calls if "ai_enriched_at" in c[0] and "ai_sentiment" not in c[0]]
        assert len(enrich_calls) == 1
        assert {p[0] for p in enrich_calls[0][1]} == {"r1", "r2"}


# ── Topic assignment ───────────────────────────────────────────────────────────

class TestTopicAssignment:
    @pytest.mark.asyncio
    async def test_assigns_to_existing_topic_and_updates_centroid(self):
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.1, 0.2]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("r1")])
        welford_mock = AsyncMock()

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=True)),
            patch("crystalos.lib.topic_registry.assign_batch_to_nearest",
                  AsyncMock(return_value=({"r1::q1": "Billing"}, []))),
            patch("crystalos.lib.topic_registry.update_centroids_welford_batch", welford_mock),
            patch("crystalos.lib.topic_registry.add_candidates_batch", AsyncMock()) as add_cand_mock,
        ):
            result = await tag_untagged_responses("s1", "o1")

        assert result["topics_assigned"] == 1
        assert result["topics_buffered"] == 0
        topic_calls = [c for c in cur.executemany_calls if "ai_topics" in c[0]]
        assert len(topic_calls) == 1
        assert topic_calls[0][1] == [('["Billing"]', "r1")]
        welford_mock.assert_awaited_once()
        add_cand_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_response_with_two_open_text_answers_can_get_two_different_topics(self):
        """The core fix (2026-07-06): topic matching used to dedupe to ONE
        embedding per response before calling assign_batch_to_nearest, so a
        response could only ever get one topic no matter how many open-text
        questions it answered. Now keyed per answer ("rid::qid"), so two
        genuinely different answers can match two genuinely different
        existing topics — both end up in that one response's ai_topics list."""
        two_q_survey = (
            '[{"id": "q1", "type": "open_text", "question": "What did you like?"},'
            ' {"id": "q2", "type": "open_text", "question": "What could improve?"}]',
        )
        row = ("r1", [
            {"questionId": "q1", "value": "The checkout flow was really smooth and fast"},
            {"questionId": "q2", "value": "Shipping costs were way higher than expected"},
        ])
        cur = _RespCursor(untagged_rows=[row], survey_row=two_q_survey)
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [
            {**t, "embedding": [0.9, 0.1] if t["question_id"] == "q1" else [0.1, 0.9]}
            for t in texts
        ])
        absa_mock = AsyncMock(return_value=[
            _absa_result("r1", qid="q1", text="The checkout flow was really smooth and fast"),
            _absa_result("r1", qid="q2", text="Shipping costs were way higher than expected"),
        ])

        async def fake_assign(embeddings_by_key, survey_id, conn):
            assignments = {
                key: ("Checkout Experience" if emb == [0.9, 0.1] else "Shipping Costs")
                for key, emb in embeddings_by_key.items()
            }
            return assignments, []

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=True)),
            patch("crystalos.lib.topic_registry.assign_batch_to_nearest", fake_assign),
            patch("crystalos.lib.topic_registry.update_centroids_welford_batch", AsyncMock()),
            patch("crystalos.lib.topic_registry.add_candidates_batch", AsyncMock()),
        ):
            result = await tag_untagged_responses("s1", "o1")

        assert result["topics_assigned"] == 1  # one RESPONSE updated, carrying 2 topics
        topic_calls = [c for c in cur.executemany_calls if "ai_topics" in c[0]]
        assert len(topic_calls) == 1
        written_json, rid = topic_calls[0][1][0]
        assert rid == "r1"
        assert set(json.loads(written_json)) == {"Checkout Experience", "Shipping Costs"}

    @pytest.mark.asyncio
    async def test_unassigned_response_is_buffered_as_candidate(self):
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.9, 0.1]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("r1")])

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=True)),
            patch("crystalos.lib.topic_registry.assign_batch_to_nearest",
                  AsyncMock(return_value=({}, ["r1::q1"]))),
            patch("crystalos.lib.topic_registry.add_candidates_batch", AsyncMock()) as add_cand_mock,
        ):
            result = await tag_untagged_responses("s1", "o1")

        assert result["topics_assigned"] == 0
        assert result["topics_buffered"] == 1
        add_cand_mock.assert_awaited_once()
        cand_args = add_cand_mock.call_args[0]
        assert cand_args[0] == "s1" and cand_args[1] == "o1"
        assert cand_args[2] == [("r1", [0.9, 0.1])]

    @pytest.mark.asyncio
    async def test_no_centroids_yet_skips_topic_assignment_entirely(self):
        """First-ever run for a survey (no centroids exist) — topic assignment
        is skipped rather than erroring; sentiment/emotion/effort still work."""
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.1]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("r1")])

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=False)) as has_cent_mock,
            patch("crystalos.lib.topic_registry.assign_batch_to_nearest", AsyncMock()) as assign_mock,
        ):
            result = await tag_untagged_responses("s1", "o1")

        has_cent_mock.assert_awaited_once()
        assign_mock.assert_not_called()
        assert result["tagged"] == 1
        assert result["topics_assigned"] == 0
        assert result["topics_buffered"] == 0


# ── New-topic discovery flush (added 2026-07-04) ──────────────────────────────

def _topic_item(name="Shipping Delays"):
    from crystalos.tools.topics import TopicItem
    return TopicItem(
        name=name, summary="Customers mention shipping delays.",
        volume=2, sentiment_score=-0.5, dominant_emotion="frustration",
    )


class TestNewTopicDiscoveryFlush:
    """tag_untagged_responses flushes+discovers new topics itself once the
    topic_candidates buffer crosses topic_discovery_candidate_threshold (resolved
    per survey/org/platform — fixed 2026-07-06, was a flat constant) — it does
    not wait for a future full pipeline run. Same resolver node_cluster uses, so
    both agree on "enough evidence"."""

    @pytest.mark.asyncio
    async def test_resolves_candidate_threshold_and_min_cluster_size_per_survey_org(self):
        """Regression test for the fix itself: both settings must be resolved
        through insight_settings, not read off a flat module constant."""
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.9, 0.1]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("r1")])

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=True)),
            patch("crystalos.lib.topic_registry.assign_batch_to_nearest", AsyncMock(return_value=({}, ["r1::q1"]))),
            patch("crystalos.lib.topic_registry.add_candidates_batch", AsyncMock()),
            patch("crystalos.lib.topic_registry.get_candidate_count", AsyncMock(return_value=1)),
            patch("crystalos.lib.response_tagging.resolve_topic_discovery_candidate_threshold",
                  AsyncMock(return_value=25)) as threshold_mock,
            patch("crystalos.lib.topic_registry.flush_candidates", AsyncMock()),
        ):
            await tag_untagged_responses("survey-9", "org-42")

        threshold_mock.assert_awaited_once_with("survey-9", "org-42")

    @pytest.mark.asyncio
    async def test_discovery_clustering_uses_the_stricter_similarity_threshold_and_resolved_cluster_size(self):
        """Regression test: incremental discovery must use
        TOPIC_DISCOVERY_SIMILARITY_THRESHOLD (0.80) and the resolved
        min_cluster_size — NOT the 0.72/2 used for nearest-centroid assignment."""
        from crystalos.lib.constants import TOPIC_DISCOVERY_SIMILARITY_THRESHOLD

        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.9, 0.1]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("r1")])

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=True)),
            patch("crystalos.lib.topic_registry.assign_batch_to_nearest", AsyncMock(return_value=({}, ["r1::q1"]))),
            patch("crystalos.lib.topic_registry.add_candidates_batch", AsyncMock()),
            patch("crystalos.lib.topic_registry.get_candidate_count", AsyncMock(return_value=25)),
            patch("crystalos.lib.response_tagging.resolve_topic_discovery_candidate_threshold",
                  AsyncMock(return_value=25)),
            patch("crystalos.lib.response_tagging.resolve_topic_discovery_min_cluster_size",
                  AsyncMock(return_value=7)) as min_cluster_mock,
            patch("crystalos.lib.topic_registry.flush_candidates", AsyncMock(return_value=[
                {"response_id": "r1", "embedding": [0.9, 0.1]},
            ])),
            patch("crystalos.lib.response_tagging.cluster_texts", MagicMock(return_value=[])) as cluster_mock,
        ):
            await tag_untagged_responses("s1", "o1")

        min_cluster_mock.assert_awaited_once()
        cluster_mock.assert_called_once()
        _, kwargs = cluster_mock.call_args
        assert kwargs["threshold"] == TOPIC_DISCOVERY_SIMILARITY_THRESHOLD
        assert kwargs["threshold"] != 0.72
        assert kwargs["min_cluster_size"] == 7  # the resolved value, not cluster_texts's own default of 2

    @pytest.mark.asyncio
    async def test_below_floor_does_not_flush(self):
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.9, 0.1]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("r1")])

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=True)),
            patch("crystalos.lib.topic_registry.assign_batch_to_nearest", AsyncMock(return_value=({}, ["r1::q1"]))),
            patch("crystalos.lib.topic_registry.add_candidates_batch", AsyncMock()),
            patch("crystalos.lib.topic_registry.get_candidate_count", AsyncMock(return_value=24)),
            patch("crystalos.lib.response_tagging.resolve_topic_discovery_candidate_threshold",
                  AsyncMock(return_value=25)),
            patch("crystalos.lib.topic_registry.flush_candidates", AsyncMock()) as flush_mock,
        ):
            result = await tag_untagged_responses("s1", "o1")

        flush_mock.assert_not_called()
        assert result["topics_discovered"] == 0

    @pytest.mark.asyncio
    async def test_at_floor_clusters_and_discovers_new_topic(self):
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.9, 0.1]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("r1", sentiment="negative", score=-0.6)])

        raw_cluster = {"texts": [
            {**_absa_result("r1", sentiment="negative", score=-0.6), "embedding": [0.9, 0.1]},
            {**_absa_result("r2", sentiment="negative", score=-0.4), "embedding": [0.91, 0.11]},
        ], "size": 2, "centroid": [0.905, 0.105]}

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=True)),
            patch("crystalos.lib.topic_registry.assign_batch_to_nearest", AsyncMock(return_value=({}, ["r1::q1"]))),
            patch("crystalos.lib.topic_registry.add_candidates_batch", AsyncMock()),
            patch("crystalos.lib.topic_registry.get_candidate_count", AsyncMock(return_value=25)),
            patch("crystalos.lib.response_tagging.resolve_topic_discovery_candidate_threshold",
                  AsyncMock(return_value=25)),
            patch("crystalos.lib.response_tagging.resolve_topic_discovery_min_cluster_size",
                  AsyncMock(return_value=2)),
            patch("crystalos.lib.topic_registry.flush_candidates", AsyncMock(return_value=[
                {"response_id": "r1", "embedding": [0.9, 0.1]},
                {"response_id": "r2", "embedding": [0.91, 0.11]},
            ])),
            patch("crystalos.lib.response_tagging.cluster_texts", MagicMock(return_value=[raw_cluster])),
            patch("crystalos.lib.topic_registry.get_centroids", AsyncMock(return_value=[])),
            patch("crystalos.lib.openrouter.call_agent", AsyncMock()),
            patch("crystalos.lib.response_tagging.discover_topics",
                  AsyncMock(return_value=[_topic_item("Shipping Delays")])),
            patch("crystalos.lib.topic_registry.insert_centroid", AsyncMock()) as insert_mock,
        ):
            result = await tag_untagged_responses("s1", "o1")

        assert result["topics_discovered"] == 1
        insert_mock.assert_awaited_once()
        assert insert_mock.call_args[0][2] == "Shipping Delays"
        topic_calls = [c for c in cur.executemany_calls if "ai_topics" in c[0]]
        assert len(topic_calls) == 1
        tagged_rids = {p[1] for p in topic_calls[0][1]}
        assert tagged_rids == {"r1", "r2"}

    @pytest.mark.asyncio
    async def test_unclustered_candidates_are_requeued_not_dropped(self):
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.9, 0.1]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("r1")])

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=True)),
            patch("crystalos.lib.topic_registry.assign_batch_to_nearest", AsyncMock(return_value=({}, ["r1::q1"]))),
            patch("crystalos.lib.topic_registry.add_candidates_batch", AsyncMock()) as add_cand_mock,
            patch("crystalos.lib.topic_registry.get_candidate_count", AsyncMock(return_value=25)),
            patch("crystalos.lib.response_tagging.resolve_topic_discovery_candidate_threshold",
                  AsyncMock(return_value=25)),
            patch("crystalos.lib.response_tagging.resolve_topic_discovery_min_cluster_size",
                  AsyncMock(return_value=2)),
            patch("crystalos.lib.topic_registry.flush_candidates", AsyncMock(return_value=[
                {"response_id": "r1", "embedding": [0.9, 0.1]},
            ])),
            patch("crystalos.lib.response_tagging.cluster_texts", MagicMock(return_value=[])),
        ):
            result = await tag_untagged_responses("s1", "o1")

        assert result["topics_discovered"] == 0
        # Buffered once for the initial unassigned-response path, then re-buffered
        # once more for the candidate that failed to cluster this round.
        requeue_calls = [c for c in add_cand_mock.call_args_list if c.args[2] == [("r1", [0.9, 0.1])]]
        assert len(requeue_calls) == 2

    @pytest.mark.asyncio
    async def test_llm_failure_requeues_candidates_and_does_not_crash_the_sweep(self):
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.9, 0.1]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("r1")])
        raw_cluster = {"texts": [
            {**_absa_result("r1"), "embedding": [0.9, 0.1]},
            {**_absa_result("r2"), "embedding": [0.91, 0.11]},
        ], "size": 2}

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=True)),
            patch("crystalos.lib.topic_registry.assign_batch_to_nearest", AsyncMock(return_value=({}, ["r1::q1"]))),
            patch("crystalos.lib.topic_registry.add_candidates_batch", AsyncMock()) as add_cand_mock,
            patch("crystalos.lib.topic_registry.get_candidate_count", AsyncMock(return_value=25)),
            patch("crystalos.lib.response_tagging.resolve_topic_discovery_candidate_threshold",
                  AsyncMock(return_value=25)),
            patch("crystalos.lib.response_tagging.resolve_topic_discovery_min_cluster_size",
                  AsyncMock(return_value=2)),
            patch("crystalos.lib.topic_registry.flush_candidates", AsyncMock(return_value=[
                {"response_id": "r1", "embedding": [0.9, 0.1]},
                {"response_id": "r2", "embedding": [0.91, 0.11]},
            ])),
            patch("crystalos.lib.response_tagging.cluster_texts", MagicMock(return_value=[raw_cluster])),
            patch("crystalos.lib.topic_registry.get_centroids", AsyncMock(return_value=[])),
            patch("crystalos.lib.response_tagging.discover_topics",
                  AsyncMock(side_effect=RuntimeError("LLM down"))),
        ):
            result = await tag_untagged_responses("s1", "o1")  # must not raise

        assert result["topics_discovered"] == 0
        # r1 + r2 re-buffered so the evidence isn't lost, on top of the initial
        # unassigned-response buffering call for r1.
        requeue_calls = [c for c in add_cand_mock.call_args_list if set(dict(c.args[2]).keys()) == {"r1", "r2"}]
        assert len(requeue_calls) == 1

    @pytest.mark.asyncio
    async def test_reconstructs_absa_items_for_candidates_from_a_prior_sweep_call(self):
        """A candidate buffered in an EARLIER sweep call (its in-memory ABSA
        result is long gone) must still be usable for clustering — reconstructed
        from its already-persisted ai_sentiment/ai_emotion columns."""
        cur = _RespCursor(
            untagged_rows=[_untagged_row("r1")],
            survey_row=_open_text_survey(),
            reconstruct_rows=[("r_old", [{"questionId": "q1", "value": "Delivery was late again"}],
                                "negative", "-0.5", "frustration")],
        )
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.9, 0.1]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("r1")])

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=True)),
            patch("crystalos.lib.topic_registry.assign_batch_to_nearest", AsyncMock(return_value=({}, ["r1::q1"]))),
            patch("crystalos.lib.topic_registry.add_candidates_batch", AsyncMock()),
            patch("crystalos.lib.topic_registry.get_candidate_count", AsyncMock(return_value=25)),
            patch("crystalos.lib.response_tagging.resolve_topic_discovery_candidate_threshold",
                  AsyncMock(return_value=25)),
            patch("crystalos.lib.response_tagging.resolve_topic_discovery_min_cluster_size",
                  AsyncMock(return_value=2)),
            # r_old was buffered in a PRIOR call — it is NOT in this call's by_resp.
            patch("crystalos.lib.topic_registry.flush_candidates", AsyncMock(return_value=[
                {"response_id": "r1", "embedding": [0.9, 0.1]},
                {"response_id": "r_old", "embedding": [0.91, 0.11]},
            ])),
            patch("crystalos.lib.response_tagging.cluster_texts") as cluster_mock,
            patch("crystalos.lib.topic_registry.get_centroids", AsyncMock(return_value=[])),
            patch("crystalos.lib.response_tagging.discover_topics",
                  AsyncMock(return_value=[_topic_item("Delivery Delays")])),
            patch("crystalos.lib.topic_registry.insert_centroid", AsyncMock()),
        ):
            # cluster_texts is called with the reconstructed items — capture them
            # via side_effect so the assertion below can inspect r_old's shape.
            captured = {}

            def _capture(texts, **kwargs):
                captured["texts"] = texts
                return [{"texts": texts, "size": len(texts)}] if len(texts) >= 2 else []

            cluster_mock.side_effect = _capture
            result = await tag_untagged_responses("s1", "o1")

        assert "r_old" in {t["response_id"] for t in captured["texts"]}
        old_item = next(t for t in captured["texts"] if t["response_id"] == "r_old")
        assert old_item["text"] == "Delivery was late again"
        assert old_item["sentiment"] == "negative"
        assert old_item["aspect"] == "general"  # no stored aspect — same fallback as _heuristic_item
        assert result["topics_discovered"] == 1


# ── Backlog / previously-failed catch-up (design invariant) ──────────────────

class TestBacklogCatchup:
    @pytest.mark.asyncio
    async def test_untagged_query_only_selects_columns_that_exist_on_responses(self):
        """Regression test for a real production failure (2026-07-05):
        'column "csat_score" does not exist'. The responses table
        (supabase/migrations/20240101000000_initial.sql) only has id, survey_id,
        org_id, answers, nps_score, respondent_id, submitted_at — NOT
        csat_score/ces_score (those live inside the answers JSONB, not as
        top-level columns). This asserts the exact column list rather than just
        'does it run', since a mocked cursor happily accepts nonexistent column
        names — that's exactly how the original bug shipped unnoticed."""
        cur = _RespCursor(untagged_rows=[])
        with patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)):
            await tag_untagged_responses("s1", "o1")

        untagged_calls = [c for c in cur.execute_calls if "ai_enriched_at IS NULL" in c[0]]
        assert len(untagged_calls) == 1
        sql = untagged_calls[0][0]
        assert "SELECT id, answers" in sql
        assert "csat_score" not in sql
        assert "ces_score" not in sql
        assert "nps_score" not in sql

    @pytest.mark.asyncio
    async def test_query_selects_all_untagged_oldest_first_not_just_new_ones(self):
        """There is no separate 'new vs backlog' distinction — every sweep call
        queries ALL untagged responses (ai_enriched_at IS NULL), oldest first, so
        a response that failed on a prior sweep (never got ai_enriched_at set)
        is automatically retried on the next call with zero extra state."""
        cur = _RespCursor(untagged_rows=[])
        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.resolve_topic_discovery_candidate_threshold",
                  AsyncMock(return_value=10)),
            patch("crystalos.lib.response_tagging.resolve_topic_discovery_min_cluster_size",
                  AsyncMock(return_value=5)),
        ):
            await tag_untagged_responses("s1", "o1")

        untagged_calls = [c for c in cur.execute_calls if "ai_enriched_at IS NULL" in c[0]]
        assert len(untagged_calls) == 1
        sql, params = untagged_calls[0]
        assert "ORDER BY submitted_at ASC" in sql
        assert params == ("s1", "o1", 50)  # default max_batch = RESPONSE_TAGGING_SWEEP_CAP

    @pytest.mark.asyncio
    async def test_fetch_untagged_responses_respects_custom_limit(self):
        cur = _RespCursor(untagged_rows=[_untagged_row("r1"), _untagged_row("r2")])
        conn = _RespConn(cur)
        rows = await _fetch_untagged_responses("s1", "o1", 5, conn)
        assert len(rows) == 2
        assert cur.execute_calls[0][1] == ("s1", "o1", 5)


# ── Whole-sweep failure isolation ─────────────────────────────────────────────

class TestSweepFailureIsolation:
    @pytest.mark.asyncio
    async def test_pool_connection_failure_returns_gracefully(self):
        pool = MagicMock()
        pool.connection = MagicMock(side_effect=RuntimeError("pool exhausted"))
        with patch("crystalos.lib.response_tagging.db._pool_conn", return_value=pool):
            result = await tag_untagged_responses("s1", "o1")
        assert result["failed"] == 1
        assert result["tagged"] == 0
