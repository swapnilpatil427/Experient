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
from unittest.mock import ANY, AsyncMock, MagicMock, patch

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
        self._untagged_desc = [("id",), ("answers",), ("ai_sentiment",), ("ai_emotion",), ("ai_effort_score",)]
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
        self.commit_count = 0
        self.rollback_count = 0

    def cursor(self):
        return self._cursor

    async def commit(self):
        self.commit_count += 1
        return None

    async def rollback(self):
        self.rollback_count += 1
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


def _untagged_row(
    rid, text="This was a genuinely great experience overall",
    ai_sentiment=None, ai_emotion=None, ai_effort_score=None,
):
    return (rid, [{"questionId": "q1", "value": text}], ai_sentiment, ai_emotion, ai_effort_score)


def _orphan_row(rid, text="This was a genuinely great experience overall"):
    """A "topic orphan" — already fully sentiment/emotion/effort-scored, only
    ai_topics missing. Only reachable via include_retriable=True."""
    return _untagged_row(rid, text, ai_sentiment="positive", ai_emotion="joy", ai_effort_score=2.5)


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
            "skipped_no_survey": False, "failed": 0, "quarantined": 0,
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
    async def test_sentiment_writeback_failure_never_crashes_the_sweep_and_records_an_attempt(self):
        """Fixed 2026-07-13 (independent review finding): a deterministic
        sentiment-writeback failure used to be swallowed WITHOUT ever recording
        an attempt, so a row with a permanently-broken writeback would be
        re-selected and re-fail forever (the exact livelock class this whole
        fix set exists to eliminate) — left uncovered for the one section given
        its own commit boundary. It now propagates into the per-row isolation
        fallback, which DOES call _record_batch_failure."""
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        cur.fail_executemany_containing = "ai_sentiment"
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.1]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("r1")])
        record_failure_mock = AsyncMock(return_value=[])

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=False)),
            patch("crystalos.lib.response_tagging._record_batch_failure", record_failure_mock),
        ):
            result = await tag_untagged_responses("s1", "o1")

        assert result["tagged"] == 0
        assert result["failed"] == 1
        record_failure_mock.assert_awaited_once_with(["r1"], ANY)


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


# ── Mixed batch: some responses have text, some don't ─────────────────────────

class TestMixedBatchNoText:
    @pytest.mark.asyncio
    async def test_marks_only_the_no_text_response_in_a_mixed_batch(self):
        """Regression test (2026-07-14): previously, _mark_enriched_no_text was
        only invoked when the ENTIRE fetched batch had no scorable text. A
        MIXED batch — one response answered the open-text question, one left
        it blank — left the blank one's ai_enriched_at permanently NULL
        (result["tagged"] never counted it, no executemany ever touched it),
        so _fetch_untagged_responses's ORDER BY submitted_at ASC would keep
        re-selecting that exact same unscoreable row on every future sweep,
        forever, instead of it ever being marked done."""
        cur = _RespCursor(
            untagged_rows=[
                _untagged_row("r1", text="Great service overall"),
                _untagged_row("r2", text=""),  # blank open-text answer
            ],
            survey_row=_open_text_survey(),
        )
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

        # r1 scored normally, r2 marked done-with-nothing-to-score — both count.
        assert result["tagged"] == 2

        no_text_calls = [c for c in cur.executemany_calls if "ai_no_scorable_text" in c[0]]
        assert len(no_text_calls) == 1
        assert [p[0] for p in no_text_calls[0][1]] == ["r2"]

        sentiment_calls = [c for c in cur.executemany_calls if "ai_sentiment" in c[0]]
        assert len(sentiment_calls) == 1
        assert sentiment_calls[0][1][0][-1] == "r1"

    @pytest.mark.asyncio
    async def test_mark_enriched_no_text_sets_the_terminal_flag(self):
        """ai_no_scorable_text must be set alongside ai_enriched_at — that flag
        is what lets the manual Catch Up Tagging job (include_retriable=True)
        tell "nothing to score, never retry" apart from a quarantined response
        that failed and IS worth retrying."""
        cur = _RespCursor(untagged_rows=[_untagged_row("r1"), _untagged_row("r2")], survey_row=("[]",))
        with patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)):
            await tag_untagged_responses("s1", "o1")

        no_text_calls = [c for c in cur.executemany_calls if "ai_no_scorable_text=TRUE" in c[0]]
        assert len(no_text_calls) == 1
        assert {p[0] for p in no_text_calls[0][1]} == {"r1", "r2"}


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


# ── Topic orphans: sentiment/emotion/effort already scored, only topics ───────
# missing (added 2026-07-14). Reachable only via include_retriable=True — see
# _fetch_untagged_responses's docstring. This is the actual bug the customer
# hit: a survey swept before its topic centroids existed (or bootstrap never
# ran at all) ends up with every response fully sentiment-tagged but zero
# topics, permanently, since neither the automatic sweep nor the OLD Catch Up
# Tagging definition of "untagged" ever revisits a response once
# ai_enriched_at is set.

class TestTopicOrphans:
    @pytest.mark.asyncio
    async def test_orphan_gets_topic_assigned_without_any_llm_rescoring(self):
        cur = _RespCursor(untagged_rows=[_orphan_row("r1")], survey_row=_open_text_survey())
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
                  AsyncMock(return_value=({"r1::q1": "Wait Time"}, []))),
            patch("crystalos.lib.topic_registry.update_centroids_welford_batch", welford_mock),
        ):
            result = await tag_untagged_responses("s1", "o1", include_retriable=True, has_centroids=True)

        # No re-scoring: the orphan's sentiment/emotion/effort was already
        # correct — an ABSA call here would just re-pay for a known answer.
        absa_mock.assert_not_called()
        # Counted as "tagged" via its topic fix, not sentiment scoring (it
        # never went through sentiment_updates) — otherwise a run that only
        # fixes orphans would misleadingly report "0 responses tagged".
        assert result["tagged"] == 1
        assert result["topics_assigned"] == 1
        topic_calls = [c for c in cur.executemany_calls if "ai_topics" in c[0]]
        assert len(topic_calls) == 1
        assert topic_calls[0][1] == [('["Wait Time"]', "r1")]
        # Sentiment/emotion/effort must never be touched for an orphan.
        sentiment_calls = [c for c in cur.executemany_calls if "ai_sentiment" in c[0]]
        assert sentiment_calls == []

    @pytest.mark.asyncio
    async def test_orphan_without_centroids_yet_does_nothing_and_is_not_an_error(self):
        """If centroids somehow don't exist despite the row being fetched
        (e.g. a race with bootstrap creating the very first centroid mid-run,
        or a direct test call bypassing the caller's own has_centroids
        check), topic assignment is a no-op — never re-scores, never
        crashes. has_centroids=True here simulates the CALLER believing
        centroids exist (so it fetched this orphan at all); has_centroids
        (the live topic_registry check inside _process_batch itself) is
        mocked False to simulate the race/staleness."""
        cur = _RespCursor(untagged_rows=[_orphan_row("r1")], survey_row=_open_text_survey())
        absa_mock = AsyncMock()

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings",
                  AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.1]} for t in texts])),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=False)),
        ):
            result = await tag_untagged_responses("s1", "o1", include_retriable=True, has_centroids=True)

        absa_mock.assert_not_called()
        assert result["tagged"] == 0
        assert result["topics_assigned"] == 0

    @pytest.mark.asyncio
    async def test_mixed_batch_only_scores_the_non_orphan_response(self):
        """A batch with one never-scored response and one orphan must ABSA-
        score ONLY the never-scored one — the orphan's embedding still feeds
        topic assignment, but its sentiment/emotion/effort is left alone."""
        cur = _RespCursor(
            untagged_rows=[_untagged_row("fresh", text="Great support team"), _orphan_row("orphan")],
            survey_row=_open_text_survey(),
        )
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.1, 0.2]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("fresh")])

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=True)),
            patch("crystalos.lib.topic_registry.assign_batch_to_nearest",
                  AsyncMock(return_value=({"fresh::q1": "Support", "orphan::q1": "Support"}, []))),
            patch("crystalos.lib.topic_registry.update_centroids_welford_batch", AsyncMock()),
        ):
            result = await tag_untagged_responses("s1", "o1", include_retriable=True, has_centroids=True)

        absa_mock.assert_awaited_once()
        called_texts = absa_mock.call_args[0][0]
        assert {t["response_id"] for t in called_texts} == {"fresh"}

        # "fresh" via sentiment scoring + "orphan" via its topic fix.
        assert result["tagged"] == 2
        assert result["topics_assigned"] == 2  # both fresh and orphan got a topic
        sentiment_calls = [c for c in cur.executemany_calls if "ai_sentiment" in c[0]]
        assert len(sentiment_calls) == 1
        assert sentiment_calls[0][1][0][-1] == "fresh"


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
    async def test_fetch_locks_rows_so_concurrent_callers_dont_double_process(self):
        """Regression test (2026-07-13, independent review finding): the live
        stream consumer, the 15-min scheduler backlog sweep, and the manual
        backfill job can all call tag_untagged_responses for the SAME survey
        concurrently. Without FOR UPDATE SKIP LOCKED they'd fetch the identical
        oldest batch and pay for embeddings + ABSA LLM calls twice for the same
        responses. A concurrent caller must transparently skip whatever another
        in-flight call already claimed."""
        cur = _RespCursor(untagged_rows=[])
        with patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)):
            await tag_untagged_responses("s1", "o1")

        untagged_calls = [c for c in cur.execute_calls if "ai_enriched_at IS NULL" in c[0]]
        assert len(untagged_calls) == 1
        assert "FOR UPDATE SKIP LOCKED" in untagged_calls[0][0]

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


# ── include_retriable: manual Catch Up Tagging's quarantine-retry mode ────────

class TestIncludeRetriable:
    @pytest.mark.asyncio
    async def test_default_query_never_retries_quarantined_responses(self):
        """The automatic stream/scheduler sweep (include_retriable's default,
        False) must never widen its own selection beyond ai_enriched_at IS
        NULL — retrying a quarantined response automatically, forever, is
        exactly what quarantine (2026-07-13) exists to prevent."""
        cur = _RespCursor(untagged_rows=[])
        conn = _RespConn(cur)
        await _fetch_untagged_responses("s1", "o1", 10, conn)
        sql = cur.execute_calls[0][0]
        assert "ai_no_scorable_text" not in sql
        assert "ai_sentiment IS NULL" not in sql

    @pytest.mark.asyncio
    async def test_include_retriable_reselects_responses_missing_scores(self):
        """Manual Catch Up Tagging (include_retriable=True) must ALSO pick up
        responses that already went through the sweep (ai_enriched_at set) but
        are still missing sentiment/emotion/effort — a quarantined response —
        while still excluding anything confirmed to have no scorable text
        (ai_no_scorable_text), or every survey with any skipped open-text
        answers would re-pay this query's cost on every future backfill click."""
        cur = _RespCursor(untagged_rows=[])
        conn = _RespConn(cur)
        await _fetch_untagged_responses("s1", "o1", 10, conn, include_retriable=True)
        sql, params = cur.execute_calls[0]
        assert "ai_enriched_at IS NOT NULL AND ai_no_scorable_text = FALSE" in sql
        assert "ai_sentiment IS NULL OR ai_emotion IS NULL OR ai_effort_score IS NULL" in sql
        assert params == ("s1", "o1", 10)

    @pytest.mark.asyncio
    async def test_include_retriable_also_reselects_topic_orphans_gated_on_centroids_existing(self):
        """Regression test (2026-07-14): a fully sentiment/emotion/effort-scored
        response missing only ai_topics (a "topic orphan") must be reselected
        too — this is the actual customer-reported bug (Data table showing
        sentiment/emotion/effort populated but Topics empty even after Catch
        Up Tagging reports success). Gated on the caller-supplied
        has_centroids — before centroids exist, topic assignment can't run at
        all, so reselecting would just waste cost for no outcome. Deliberately
        a plain boolean threaded through by the caller (who already knows the
        answer — see run_topic_backfill's has_centroids), not a fresh
        EXISTS (SELECT …) subquery evaluated per row here (fixed 2026-07-14,
        self-review finding)."""
        cur = _RespCursor(untagged_rows=[])
        conn = _RespConn(cur)
        await _fetch_untagged_responses("s1", "o1", 10, conn, include_retriable=True, has_centroids=True)
        sql = cur.execute_calls[0][0]
        assert "ai_topics IS NULL" in sql
        assert "EXISTS" not in sql
        assert "survey_topic_centroids" not in sql

    @pytest.mark.asyncio
    async def test_include_retriable_omits_topic_orphan_clause_when_centroids_dont_exist(self):
        cur = _RespCursor(untagged_rows=[])
        conn = _RespConn(cur)
        await _fetch_untagged_responses("s1", "o1", 10, conn, include_retriable=True, has_centroids=False)
        sql = cur.execute_calls[0][0]
        assert "ai_topics" not in sql

    @pytest.mark.asyncio
    async def test_fetch_untagged_responses_selects_enrichment_columns(self):
        """_process_batch needs ai_sentiment/ai_emotion/ai_effort_score on each
        fetched row to tell a topic orphan (already scored) apart from a
        response that genuinely needs full ABSA scoring."""
        cur = _RespCursor(untagged_rows=[_orphan_row("r1")])
        conn = _RespConn(cur)
        rows = await _fetch_untagged_responses("s1", "o1", 10, conn)
        assert rows[0]["ai_sentiment"] == "positive"
        assert rows[0]["ai_emotion"] == "joy"
        assert rows[0]["ai_effort_score"] == 2.5
        sql = cur.execute_calls[0][0]
        assert "ai_sentiment, ai_emotion, ai_effort_score" in sql

    @pytest.mark.asyncio
    async def test_tag_untagged_responses_threads_include_retriable_through(self):
        cur = _RespCursor(untagged_rows=[])
        with patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)):
            await tag_untagged_responses("s1", "o1", include_retriable=True)

        untagged_calls = [c for c in cur.execute_calls if "FROM responses" in c[0] and "ai_enriched_at IS NULL" in c[0]]
        assert len(untagged_calls) == 1
        assert "ai_no_scorable_text = FALSE" in untagged_calls[0][0]

    @pytest.mark.asyncio
    async def test_tag_untagged_responses_defaults_to_not_retrying(self):
        cur = _RespCursor(untagged_rows=[])
        with patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)):
            await tag_untagged_responses("s1", "o1")

        untagged_calls = [c for c in cur.execute_calls if "FROM responses" in c[0] and "ai_enriched_at IS NULL" in c[0]]
        assert len(untagged_calls) == 1
        assert "ai_no_scorable_text" not in untagged_calls[0][0]


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


# ── Split commit boundary (2026-07-13 fix) ────────────────────────────────────
# The whole function used to be one all-or-nothing transaction: a topic-section
# exception rolled back sentiment/emotion/effort scoring that had already
# succeeded. Since _fetch_untagged_responses always re-selects the oldest
# untagged rows first, that meant a single response that reliably broke topic
# assignment would poison EVERY future sweep forever, blocking every response
# behind it — the literal production incident that motivated this fix.

class TestSplitCommitBoundary:
    @pytest.mark.asyncio
    async def test_topic_section_exception_does_not_roll_back_already_committed_sentiment(self):
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.1, 0.2]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("r1")])
        pool = _pool_for(cur)
        conn = pool.connection()

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=pool),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            # Simulate an unexpected exception deep in the topic section — even
            # though assign_batch_to_nearest itself is now hardened, this proves
            # the commit split protects sentiment regardless of WHAT breaks here.
            patch("crystalos.lib.topic_registry.has_centroids",
                  AsyncMock(side_effect=RuntimeError("simulated topic-section crash"))),
        ):
            result = await tag_untagged_responses("s1", "o1")

        assert result["tagged"] == 1
        assert result["failed"] == 0
        sentiment_calls = [c for c in cur.executemany_calls if "ai_sentiment" in c[0]]
        assert len(sentiment_calls) == 1
        # Sentiment writeback's commit happened before the topic section blew up.
        assert conn.commit_count >= 1

    @pytest.mark.asyncio
    async def test_sentiment_writeback_commits_before_topic_work_starts(self):
        """Direct proof of ordering: has_centroids must observe a connection that
        has already committed the sentiment write (not merely executed it)."""
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.1, 0.2]} for t in texts])
        absa_mock = AsyncMock(return_value=[_absa_result("r1")])
        pool = _pool_for(cur)
        conn = pool.connection()
        commit_count_when_checked = {}

        async def _capture_commit_count(*a, **kw):
            commit_count_when_checked["value"] = conn.commit_count
            return False

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=pool),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(side_effect=_capture_commit_count)),
        ):
            await tag_untagged_responses("s1", "o1")

        assert commit_count_when_checked["value"] == 1


# ── Quarantine circuit breaker (2026-07-13 fix) ───────────────────────────────
# A response that keeps failing (whatever the cause) must eventually stop being
# re-selected by the oldest-first query, otherwise it permanently blocks every
# response behind it. _record_batch_failure bumps ai_tagging_attempts and
# quarantines (sets ai_enriched_at) once MAX_RESPONSE_TAGGING_ATTEMPTS is hit.

class _AttemptsCursor:
    def __init__(self, returning_rows):
        self._returning_rows = returning_rows
        self.execute_calls = []
        self.executemany_calls = []

    async def execute(self, sql, params=None):
        self.execute_calls.append((sql, params))

    async def executemany(self, sql, params_list):
        self.executemany_calls.append((sql, list(params_list)))

    async def fetchall(self):
        return self._returning_rows

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _AttemptsConn:
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


def _attempts_pool(cursor):
    conn = _AttemptsConn(cursor)
    pool = MagicMock()
    pool.connection = MagicMock(return_value=conn)
    return pool


class TestQuarantineCircuitBreaker:
    @pytest.mark.asyncio
    async def test_below_max_attempts_bumps_counter_but_does_not_quarantine(self):
        from crystalos.lib.response_tagging import _record_batch_failure

        # (id, attempts, already_enriched) — 1st failure, MAX is 3, never touched before.
        cur = _AttemptsCursor(returning_rows=[("r1", 1, False)])
        with patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_attempts_pool(cur)):
            quarantined = await _record_batch_failure(["r1"], "boom")

        assert quarantined == []
        update_calls = [c for c in cur.executemany_calls if "ai_enriched_at" in c[0]]
        assert update_calls == []

    @pytest.mark.asyncio
    async def test_reaching_max_attempts_quarantines_the_response(self):
        from crystalos.lib.response_tagging import _record_batch_failure
        from crystalos.lib.constants import MAX_RESPONSE_TAGGING_ATTEMPTS

        cur = _AttemptsCursor(returning_rows=[("r1", MAX_RESPONSE_TAGGING_ATTEMPTS, False)])
        with patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_attempts_pool(cur)):
            quarantined = await _record_batch_failure(["r1"], "boom")

        assert quarantined == ["r1"]
        update_calls = [c for c in cur.executemany_calls if "ai_enriched_at" in c[0]]
        assert len(update_calls) == 1
        assert update_calls[0][1] == [("r1",)]

    @pytest.mark.asyncio
    async def test_attempts_guard_also_matches_retried_quarantined_responses(self):
        """Regression test (2026-07-14): a response already quarantined
        (ai_enriched_at set) that gets manually retried via Catch Up Tagging's
        include_retriable mode and fails AGAIN must still have this UPDATE's
        WHERE clause match it. The old guard (ai_enriched_at IS NULL alone)
        would silently match zero rows for an already-quarantined response —
        ai_tagging_attempts/ai_tagging_last_error would go stale, and ops
        would have no visibility that a retry was even attempted."""
        from crystalos.lib.response_tagging import _record_batch_failure

        cur = _AttemptsCursor(returning_rows=[("r1", 4, True)])  # already_enriched=True: a repeat failure
        with patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_attempts_pool(cur)):
            await _record_batch_failure(["r1"], "boom again")

        sql = cur.execute_calls[0][0]
        assert "ai_enriched_at IS NULL" in sql
        assert "ai_enriched_at IS NOT NULL AND ai_no_scorable_text = FALSE" in sql
        assert "ai_sentiment IS NULL OR ai_emotion IS NULL OR ai_effort_score IS NULL" in sql

    @pytest.mark.asyncio
    async def test_repeat_failure_of_an_already_quarantined_response_is_not_counted_as_new(self):
        """THE critical regression test (2026-07-14): without this exclusion,
        fixing the "stale attempts on retry" gap above would silently reopen a
        livelock in a different layer. lib/topic_backfill.py::run_topic_backfill
        treats a non-empty quarantined count as "this chunk made real
        progress" and resets its stall-detection counter accordingly — that's
        correct ONLY because quarantining used to be a one-time event. Once a
        manually-retried, already-quarantined response can be "quarantined"
        again on every repeat failure, counting it here every time would make
        every future chunk look like it's progressing even though the exact
        same permanently-broken responses are being retried forever — the
        run's own stall safety valve would never trip, and the user-facing
        "N responses were quarantined" total would double/triple/quadruple
        count the same handful of responses across chunks."""
        from crystalos.lib.response_tagging import _record_batch_failure
        from crystalos.lib.constants import MAX_RESPONSE_TAGGING_ATTEMPTS

        # already_enriched=True (it was quarantined before this call) even
        # though attempts is now well past MAX — must NOT be treated as new.
        cur = _AttemptsCursor(returning_rows=[("r1", MAX_RESPONSE_TAGGING_ATTEMPTS + 5, True)])
        with patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_attempts_pool(cur)):
            quarantined = await _record_batch_failure(["r1"], "boom yet again")

        assert quarantined == []
        # Still no redundant ai_enriched_at re-set for a row that already has one.
        update_calls = [c for c in cur.executemany_calls if "ai_enriched_at" in c[0]]
        assert update_calls == []

    @pytest.mark.asyncio
    async def test_mixed_batch_only_counts_the_genuinely_new_quarantine(self):
        """A batch containing both a never-touched response crossing the
        threshold for the first time and an already-quarantined response
        failing again must only report the former."""
        from crystalos.lib.response_tagging import _record_batch_failure
        from crystalos.lib.constants import MAX_RESPONSE_TAGGING_ATTEMPTS

        cur = _AttemptsCursor(returning_rows=[
            ("new", MAX_RESPONSE_TAGGING_ATTEMPTS, False),
            ("retry", MAX_RESPONSE_TAGGING_ATTEMPTS + 2, True),
        ])
        with patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_attempts_pool(cur)):
            quarantined = await _record_batch_failure(["new", "retry"], "boom")

        assert quarantined == ["new"]

    @pytest.mark.asyncio
    async def test_empty_response_ids_is_a_noop(self):
        from crystalos.lib.response_tagging import _record_batch_failure

        pool = MagicMock()
        with patch("crystalos.lib.response_tagging.db._pool_conn", return_value=pool):
            quarantined = await _record_batch_failure([], "boom")
        assert quarantined == []
        pool.connection.assert_not_called()

    @pytest.mark.asyncio
    async def test_record_batch_failure_itself_never_raises(self):
        from crystalos.lib.response_tagging import _record_batch_failure

        pool = MagicMock()
        pool.connection = MagicMock(side_effect=RuntimeError("pool exhausted"))
        with patch("crystalos.lib.response_tagging.db._pool_conn", return_value=pool):
            quarantined = await _record_batch_failure(["r1"], "boom")
        assert quarantined == []

    @pytest.mark.asyncio
    async def test_whole_sweep_failure_calls_record_batch_failure_with_fetched_response_ids(self):
        """End-to-end: when the whole sweep throws (any cause), the responses that
        were fetched at the top of this call get their attempt counter bumped —
        this is what eventually quarantines a genuinely poisoned response instead
        of retrying it forever."""
        cur = _RespCursor(untagged_rows=[_untagged_row("r1")], survey_row=_open_text_survey())
        record_failure_mock = AsyncMock(return_value=[])

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings",
                  AsyncMock(side_effect=RuntimeError("embedding service down"))),
            patch("crystalos.lib.response_tagging.extract_open_texts",
                  side_effect=RuntimeError("simulated top-level crash")),
            patch("crystalos.lib.response_tagging._record_batch_failure", record_failure_mock),
        ):
            result = await tag_untagged_responses("s1", "o1")

        assert result["failed"] == 1
        record_failure_mock.assert_awaited_once()
        called_ids, called_error = record_failure_mock.call_args[0]
        assert called_ids == ["r1"]
        assert "simulated top-level crash" in called_error

    @pytest.mark.asyncio
    async def test_one_poison_response_does_not_quarantine_its_healthy_batch_neighbors(self):
        """THE core regression test for the independent-review finding
        (2026-07-13): the circuit breaker used to be batch-granular — one
        malformed response crashing extract_open_texts for the WHOLE fetched
        batch (a real Python loop with no per-item try/except) meant EVERY
        response in that batch got an attempt bumped, and after 3 failed
        sweeps ALL of them — including perfectly healthy neighbors — were
        permanently quarantined with zero AI data. That was strictly worse
        than the original livelock, which lost no data. Now a whole-batch
        failure falls back to processing responses one at a time: only the
        response that ALSO fails individually is ever penalized, and its
        healthy neighbor gets tagged normally in the very same call."""
        cur = _RespCursor(
            untagged_rows=[_untagged_row("poison"), _untagged_row("good")],
            survey_row=_open_text_survey(),
        )
        embed_mock = AsyncMock(side_effect=lambda texts, conn: [{**t, "embedding": [0.1, 0.2]} for t in texts])
        absa_mock = AsyncMock(side_effect=lambda texts, *a, **kw: [_absa_result(t["response_id"]) for t in texts])
        record_failure_mock = AsyncMock(return_value=[])

        def fake_extract(responses, questions):
            # Simulates a real bug class: ONE malformed response (e.g. a
            # non-list `answers` field) crashes the whole-list extraction —
            # this is exactly what extract_open_texts's actual implementation
            # would do, since it has no per-response try/except.
            if any(r["id"] == "poison" for r in responses):
                raise RuntimeError("malformed answers field")
            return [
                {"response_id": r["id"], "question_id": "q1", "text": "great experience", "question": "Anything else?"}
                for r in responses
            ]

        with (
            patch("crystalos.lib.response_tagging.db._pool_conn", return_value=_pool_for(cur)),
            patch("crystalos.lib.response_tagging.extract_open_texts", side_effect=fake_extract),
            patch("crystalos.lib.response_tagging.get_or_create_embeddings", embed_mock),
            patch("crystalos.lib.response_tagging.get_absa_config", return_value=_ABSA_CFG),
            patch("crystalos.lib.response_tagging.run_absa_llm", absa_mock),
            patch("crystalos.lib.topic_registry.has_centroids", AsyncMock(return_value=False)),
            patch("crystalos.lib.response_tagging._record_batch_failure", record_failure_mock),
        ):
            result = await tag_untagged_responses("s1", "o1")

        # "good" got tagged normally despite sharing a fetched batch with "poison".
        assert result["tagged"] == 1
        sentiment_calls = [c for c in cur.executemany_calls if "ai_sentiment" in c[0]]
        tagged_ids = {p[-1] for _, params in sentiment_calls for p in params}
        assert tagged_ids == {"good"}

        # Only "poison" was ever handed to the failure/quarantine tracker.
        record_failure_mock.assert_awaited_once()
        called_ids, _called_error = record_failure_mock.call_args[0]
        assert called_ids == ["poison"]
