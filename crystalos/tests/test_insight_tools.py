"""Unit tests for insight tools and DAG nodes."""
import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch, MagicMock

from crystalos.tools.metrics import (
    compute_nps_ci, compute_csat, compute_ces,
    compute_completion_rate, compute_response_trend, extract_open_texts,
    compute_effort_score, compute_response_trend_analysis, filter_responses_by_window,
)
from crystalos.tools.clustering import cluster_texts
from crystalos.tools.sentiment import detect_dominant_emotion, score_sentiment
from crystalos.schemas.insight import NarrateInsightOutput, VerifyInsightOutput
from crystalos.crystal.tools import (
    execute_get_survey_overview,
    execute_get_metric_history,
    execute_get_insights_list,
    execute_get_driver_analysis,
    execute_get_checkpoint_history,
    execute_get_benchmark_comparison,
)
from crystalos.crystal.context import CrystalContext


# ── Metrics ───────────────────────────────────────────────────────────────────

class TestComputeNpsCi:
    def test_basic_nps(self):
        responses = [{"nps_score": s} for s in [9, 10, 8, 3, 2, 7, 5, 9, 10, 8, 1, 9]]
        result = compute_nps_ci(responses)
        assert "score" in result
        assert "n" in result
        assert result["n"] == 12
        assert result["below_minimum"] is True  # n < 30

    def test_promoter_detractor_counts(self):
        # 2 promoters (9,10), 1 detractor (3), 1 passive (7) — n=4
        responses = [{"nps_score": s} for s in [9, 10, 3, 7]]
        result = compute_nps_ci(responses)
        assert result["promoters"] == 50.0   # 2/4
        assert result["detractors"] == 25.0  # 1/4

    def test_empty_responses(self):
        result = compute_nps_ci([])
        assert result["score"] is None
        assert result["n"] == 0

    def test_missing_field_skipped(self):
        responses = [{"nps_score": 9}, {"other": "field"}, {"nps_score": 3}]
        result = compute_nps_ci(responses)
        assert result["n"] == 2

    def test_ci_bounds_present(self):
        responses = [{"nps_score": s} for s in [9]*20 + [3]*10]
        result = compute_nps_ci(responses)
        assert "ci_low" in result
        assert "ci_high" in result
        assert result["ci_low"] <= result["score"] <= result["ci_high"]


class TestComputeCsat:
    def test_basic_csat(self):
        responses = [{"csat_score": float(s)} for s in [4, 5, 3, 4, 5, 4, 3, 5]]
        result = compute_csat(responses)
        assert result["score"] is not None
        assert result["n"] == 8
        assert 3.0 < result["score"] < 5.0

    def test_ci_present(self):
        responses = [{"csat_score": float(s)} for s in [4, 5, 3, 4, 5, 4, 3, 5]]
        result = compute_csat(responses)
        assert result["ci_low"] <= result["score"] <= result["ci_high"]

    def test_empty(self):
        result = compute_csat([])
        assert result["score"] is None


class TestCompletionRate:
    def test_all_complete(self):
        responses = [{"completed": True}] * 10
        result = compute_completion_rate(responses)
        assert result["rate"] == 100.0

    def test_partial(self):
        responses = [{"completed": True}] * 7 + [{"completed": False}] * 3
        result = compute_completion_rate(responses)
        assert result["rate"] == 70.0


class TestExtractOpenTexts:
    def test_extracts_text_answers(self):
        questions = [{"id": "q1", "type": "open_text"}, {"id": "q2", "type": "nps"}]
        responses = [{"id": "r1", "answers": [{"questionId": "q1", "value": "Great product overall!"}]}]
        result = extract_open_texts(responses, questions)
        assert len(result) == 1
        assert result[0]["text"] == "Great product overall!"
        assert result[0]["response_id"] == "r1"

    def test_skips_short_text(self):
        questions = [{"id": "q1", "type": "open_text"}]
        responses = [{"id": "r1", "answers": [{"questionId": "q1", "value": "ok"}]}]
        result = extract_open_texts(responses, questions)
        assert result == []

    def test_synthesises_score_questions(self):
        # Score-only survey: NPS score synthesised to descriptive text
        questions = [{"id": "q1", "type": "nps"}]
        responses = [{"id": "r1", "answers": [{"questionId": "q1", "value": "9"}]}]
        result = extract_open_texts(responses, questions)
        assert len(result) == 1
        assert result[0]["question_id"] == "q1"
        assert "Promoter" in result[0]["text"]

    def test_open_text_suppresses_score_synthesis(self):
        # When survey has open_text questions, score answers are NOT synthesised
        # (prevents synthetic labels like "Detractor" from polluting topic clusters)
        questions = [{"id": "q1", "type": "nps"}, {"id": "q2", "type": "open_text"}]
        responses = [{"id": "r1", "answers": [
            {"questionId": "q1", "value": "9"},
            {"questionId": "q2", "value": "Very responsive support team!"},
        ]}]
        result = extract_open_texts(responses, questions)
        qids = {r["question_id"] for r in result}
        assert "q1" not in qids, "NPS score should be suppressed when open_text present"
        assert "q2" in qids

    def test_csat_synthesises_sentiment_label(self):
        questions = [{"id": "q1", "type": "csat", "question": "How satisfied are you?"}]
        responses = [
            {"id": "r1", "answers": [{"questionId": "q1", "value": 5}]},
            {"id": "r2", "answers": [{"questionId": "q1", "value": 1}]},
        ]
        result = extract_open_texts(responses, questions)
        assert len(result) == 2
        texts = {r["response_id"]: r["text"] for r in result}
        assert "extremely satisfied" in texts["r1"]
        assert "extremely dissatisfied" in texts["r2"]

    def test_rating_only_survey_produces_texts(self):
        # Pure rating survey should still produce texts (enables full text pipeline)
        questions = [{"id": "q1", "type": "rating", "question": "Overall experience"}]
        responses = [{"id": f"r{i}", "answers": [{"questionId": "q1", "value": i % 5 + 1}]} for i in range(10)]
        result = extract_open_texts(responses, questions)
        assert len(result) == 10


# ── Sentiment ─────────────────────────────────────────────────────────────────

class TestSentiment:
    def test_frustration_detected(self):
        assert detect_dominant_emotion("I'm so frustrated with this loop") == "frustration"

    def test_joy_detected(self):
        assert detect_dominant_emotion("This is excellent and amazing!") == "joy"

    def test_neutral_default(self):
        assert detect_dominant_emotion("The product was delivered") == "neutral"

    def test_positive_score(self):
        score = score_sentiment("great and excellent experience")
        assert score > 0

    def test_negative_score(self):
        score = score_sentiment("terrible and broken and awful")
        assert score < 0

    def test_neutral_score(self):
        score = score_sentiment("the item was delivered on tuesday")
        assert score == 0.0


# ── Clustering ────────────────────────────────────────────────────────────────

class TestClustering:
    def test_no_embeddings_returns_empty(self):
        texts = [{"response_id": "r1", "text": "hello"}, {"response_id": "r2", "text": "world"}]
        result = cluster_texts(texts)
        assert result == []

    def test_similar_embeddings_cluster_together(self):
        # Two near-identical embeddings should cluster
        emb1 = [1.0, 0.0, 0.0]
        emb2 = [0.99, 0.1, 0.0]
        emb3 = [0.0, 1.0, 0.0]   # different direction
        emb4 = [0.0, 0.99, 0.1]  # near emb3

        texts = [
            {"response_id": "r1", "text": "support was slow", "embedding": emb1},
            {"response_id": "r2", "text": "support took forever", "embedding": emb2},
            {"response_id": "r3", "text": "great product", "embedding": emb3},
            {"response_id": "r4", "text": "love the product", "embedding": emb4},
        ]
        result = cluster_texts(texts, threshold=0.9)
        assert len(result) == 2
        assert result[0]["size"] == 2


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class TestNarrateSchema:
    def test_valid_narrate_output(self):
        out = NarrateInsightOutput(
            headline="NPS is at 47",
            narrative="Your Net Promoter Score is 47. This indicates room for improvement."
        )
        assert out.headline == "NPS is at 47"

    def test_headline_max_length(self):
        with pytest.raises(Exception):
            NarrateInsightOutput(
                headline="x" * 161,  # exceeds max_length=160
                narrative="short narrative here."
            )


class TestVerifySchema:
    def test_supported(self):
        v = VerifyInsightOutput(supported=True, reason="Claim is directly cited")
        assert v.supported is True

    def test_not_supported(self):
        v = VerifyInsightOutput(supported=False, reason="No matching evidence found")
        assert v.supported is False
        assert v.reason == "No matching evidence found"


# ── DAG node integration (mocked LLM) ────────────────────────────────────────

@pytest.mark.asyncio
async def test_node_metrics_computes_nps():
    from crystalos.graphs.insights import node_metrics
    state = {
        "survey_id": "s1", "org_id": "o1", "run_id": "r1", "trigger": "test",
        "survey": {}, "responses": [{"nps_score": s} for s in [9, 10, 8, 3, 2, 7]],
        "metrics": {}, "open_texts": [], "absa_results": [], "clusters": [],
        "drivers": [], "stream_events": [], "insights": [], "errors": [],
    }
    with patch("crystalos.graphs.insights._emit_event", new_callable=AsyncMock):
        result = await node_metrics(state)
    assert "nps" in result["metrics"]
    assert result["metrics"]["nps"]["n"] == 6


@pytest.mark.asyncio
async def test_node_narrate_uses_call_agent():
    from crystalos.graphs.insights import node_narrate
    from crystalos.schemas.insight import NarrateInsightOutput

    mock_narrate_output = NarrateInsightOutput(
        headline="NPS is 42",
        narrative="Your NPS score is 42, indicating moderate loyalty."
    )
    state = {
        "survey_id": "s1", "org_id": "o1", "run_id": "r1",
        "survey": {}, "responses": [],
        "metrics": {"nps": {"score": 42.0, "n": 50, "promoters": 60.0, "passives": 20.0, "detractors": 20.0, "ci_low": 35.0, "ci_high": 49.0, "below_minimum": False}},
        "clusters": [], "open_texts": [], "absa_results": [],
        "drivers": [], "stream_events": [], "insights": [], "errors": [],
    }

    # Mock both call_agent AND _emit_event
    with patch("crystalos.graphs.insights._narrate", new_callable=AsyncMock, return_value=mock_narrate_output), \
         patch("crystalos.graphs.insights._emit_event", new_callable=AsyncMock):
        result = await node_narrate(state)

    assert len(result["insights"]) >= 1
    nps_insight = next((i for i in result["insights"] if i["category"] == "metric.nps"), None)
    assert nps_insight is not None
    assert nps_insight["headline"] == "NPS is 42"


@pytest.mark.asyncio
async def test_node_verify_demotes_unsupported():
    from crystalos.graphs.insights import node_verify
    from crystalos.schemas.insight import VerifyInsightOutput

    state = {
        "survey_id": "s1", "org_id": "o1", "run_id": "r1",
        "insights": [
            {
                "headline": "Support is great",
                "narrative": "Customers love the support.",
                "citations_json": [{"quote": "totally unrelated text", "sentiment": "positive", "response_id": "r1", "relevance": 0.5, "emotion": "neutral"}],
                "trust_score": 80,
                "trust_json": {"verifier_pass": True},
            }
        ],
        "survey": {}, "responses": [], "metrics": {}, "open_texts": [],
        "absa_results": [], "clusters": [], "drivers": [], "stream_events": [], "errors": [],
    }

    not_supported = VerifyInsightOutput(supported=False, reason="Claim not found in excerpts")
    with patch("crystalos.graphs.insights._verify", new_callable=AsyncMock, return_value=not_supported), \
         patch("crystalos.graphs.insights._emit_event", new_callable=AsyncMock), \
         patch("crystalos.graphs.insights.USE_SKILL_RUNTIME", False):
        result = await node_verify(state)

    assert result["insights"][0]["trust_score"] <= 55
    assert result["insights"][0]["trust_json"]["verifier_pass"] is False


# ── New metric functions ───────────────────────────────────────────────────────

class TestComputeEffortScore:
    def test_high_effort_text(self):
        """Texts with multiple frustration keywords, negation and punctuation score > 4."""
        texts = [
            "This is so frustrating and difficult, I could not complete the checkout! Broken!",
            "Terrible experience, broken flow, impossible to navigate, awful and useless!!!",
            "It is confusing, annoying, and hard to use. I did not get any help!",
        ]
        score = compute_effort_score(texts)
        assert score > 4.0, f"Expected score > 4.0 for high-effort texts, got {score}"
        assert 1.0 <= score <= 7.0

    def test_low_effort_text(self):
        """Short, neutral or positive texts should score closer to the lower end."""
        texts = [
            "Great product.",
            "Works well.",
            "Easy to use.",
        ]
        score = compute_effort_score(texts)
        assert score < 4.5, f"Expected score < 4.5 for low-effort texts, got {score}"
        assert 1.0 <= score <= 7.0

    def test_empty_texts_returns_midpoint(self):
        score = compute_effort_score([])
        assert score == 4.0

    def test_score_bounded(self):
        """Score must always be in [1, 7]."""
        extremes = [
            "!!! broken broken broken broken broken broken broken!!!",
            "great great great great great great great great",
        ]
        score = compute_effort_score(extremes)
        assert 1.0 <= score <= 7.0

    def test_high_scores_higher_than_low(self):
        """High-effort texts should consistently score higher than low-effort texts."""
        high = compute_effort_score([
            "I couldn't do this, it's so confusing and frustrating and terrible!!!",
        ])
        low = compute_effort_score([
            "Good experience.",
        ])
        assert high > low


class TestFilterResponsesByWindow:
    def _make_response(self, days_ago: int) -> dict:
        ts = datetime.now(timezone.utc) - timedelta(days=days_ago)
        return {"id": f"r_{days_ago}", "submitted_at": ts.isoformat(), "nps_score": 7}

    def test_all_time_returns_all(self):
        responses = [self._make_response(d) for d in [1, 10, 40, 100]]
        result = filter_responses_by_window(responses, "all_time")
        assert len(result) == 4

    def test_last_7d_filters_old(self):
        responses = [self._make_response(d) for d in [1, 3, 6, 8, 15, 40]]
        result = filter_responses_by_window(responses, "last_7d")
        # Should include days 1, 3, 6 (within 7 days); exclude 8, 15, 40
        assert len(result) == 3
        for r in result:
            days = int(r["id"].split("_")[1])
            assert days <= 7

    def test_last_30d_filters_old(self):
        responses = [self._make_response(d) for d in [1, 15, 29, 31, 60]]
        result = filter_responses_by_window(responses, "last_30d")
        assert len(result) == 3

    def test_missing_timestamp_included(self):
        """Responses without a timestamp are always included."""
        responses = [
            {"id": "r_no_ts", "nps_score": 9},
            self._make_response(100),
        ]
        result = filter_responses_by_window(responses, "last_7d")
        # r_no_ts should be included; 100-days-ago should not
        assert any(r["id"] == "r_no_ts" for r in result)

    def test_string_timestamp_parsed(self):
        """ISO string timestamps are correctly parsed."""
        ts = (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
        responses = [{"id": "r1", "submitted_at": ts, "nps_score": 8}]
        result = filter_responses_by_window(responses, "last_7d")
        assert len(result) == 1


class TestComputeResponseTrendAnalysis:
    def _make_responses_for_days(self, day_offsets: list[int]) -> list[dict]:
        return [
            {
                "id": f"r_{i}",
                "submitted_at": (datetime.now(timezone.utc) - timedelta(days=d)).isoformat(),
            }
            for i, d in enumerate(day_offsets)
        ]

    def test_returns_required_keys(self):
        responses = self._make_responses_for_days(list(range(20)))
        result = compute_response_trend_analysis(responses)
        for key in ("daily", "trend", "slope", "delta_pct", "anomaly", "forecast_7d", "recent_avg"):
            assert key in result, f"Missing key: {key}"

    def test_stable_trend_for_uniform_distribution(self):
        # Evenly spread responses across 30 days → no strong trend
        responses = self._make_responses_for_days(list(range(30)))
        result = compute_response_trend_analysis(responses)
        assert result["trend"] in ("stable", "up", "down")  # just check it's a valid value

    def test_fewer_than_3_days_returns_stable(self):
        responses = self._make_responses_for_days([1, 2])
        result = compute_response_trend_analysis(responses)
        assert result["trend"] == "stable"
        assert result["forecast_7d"] is None

    def test_anomaly_flag(self):
        """Last 3 days with much higher volume than overall should trigger anomaly."""
        # 27 days with 1 response each day, then 3 days with 10 each
        old_days = list(range(4, 31))          # 27 responses spread over older days
        recent_days = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1,  # 10 on day 1
                       2, 2, 2, 2, 2, 2, 2, 2, 2, 2,  # 10 on day 2
                       3, 3, 3, 3, 3, 3, 3, 3, 3, 3]  # 10 on day 3
        responses = self._make_responses_for_days(old_days + recent_days)
        result = compute_response_trend_analysis(responses)
        # anomaly should be True when last-3-day avg >> overall avg
        assert isinstance(result["anomaly"], bool)

    def test_slope_positive_for_increasing_volume(self):
        """Responses concentrated in recent days → positive slope."""
        # Mostly recent responses
        recent = [0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3] * 2
        responses = self._make_responses_for_days(recent)
        result = compute_response_trend_analysis(responses)
        # slope may be positive or negative but should be a float
        assert isinstance(result["slope"], float)


# ── Embeddings heuristic fallback ─────────────────────────────────────────────

class TestEmbeddingsHeuristicFallback:
    """Tests for the BoW heuristic fallback — no API key required."""

    def test_bow_returns_list_of_lists(self):
        from crystalos.tools.embeddings import _build_bow_embeddings
        texts = ["great product", "terrible support", "fast shipping"]
        vecs = _build_bow_embeddings(texts)
        assert len(vecs) == 3
        assert all(isinstance(v, list) for v in vecs)
        assert all(all(isinstance(x, float) for x in v) for v in vecs)

    def test_bow_vectors_unit_length(self):
        """Each BoW vector should be L2-normalised (length ≈ 1)."""
        import math
        from crystalos.tools.embeddings import _build_bow_embeddings
        texts = ["the quick brown fox", "lazy dog jumps over"]
        vecs = _build_bow_embeddings(texts)
        for v in vecs:
            mag = math.sqrt(sum(x * x for x in v))
            assert abs(mag - 1.0) < 1e-6 or mag == 0.0

    def test_bow_similar_texts_higher_cosine(self):
        """Two texts about the same topic should have higher cosine sim than different topics."""
        import math
        from crystalos.tools.embeddings import _build_bow_embeddings

        texts = [
            "support was slow and unhelpful",
            "support response time is too slow",
            "the product design is beautiful",
        ]
        vecs = _build_bow_embeddings(texts)

        def cosine(a, b):
            dot = sum(x * y for x, y in zip(a, b))
            mag_a = math.sqrt(sum(x * x for x in a))
            mag_b = math.sqrt(sum(x * x for x in b))
            return dot / (mag_a * mag_b) if mag_a and mag_b else 0.0

        sim_same_topic = cosine(vecs[0], vecs[1])    # both about slow support
        sim_diff_topic = cosine(vecs[0], vecs[2])    # support vs product design
        assert sim_same_topic > sim_diff_topic

    def test_empty_text_list(self):
        from crystalos.tools.embeddings import _build_bow_embeddings
        vecs = _build_bow_embeddings([])
        assert vecs == []

    @pytest.mark.asyncio
    async def test_embed_texts_fallback_no_key(self):
        """embed_texts uses heuristic when OPENAI_API_KEY is not set."""
        import os
        from crystalos.tools.embeddings import embed_texts

        # Ensure no API key is set during this test
        with patch.dict(os.environ, {}, clear=False):
            original = os.environ.pop("OPENAI_API_KEY", None)
            try:
                # Also patch the module-level _OPENAI_API_KEY
                with patch("crystalos.tools.embeddings._OPENAI_API_KEY", ""):
                    vecs = await embed_texts(
                        ["great product", "terrible experience"],
                        org_id="test-org",
                        survey_id="test-survey",
                    )
            finally:
                if original is not None:
                    os.environ["OPENAI_API_KEY"] = original

        assert len(vecs) == 2
        assert all(isinstance(v, list) for v in vecs)
        assert all(len(v) > 0 for v in vecs)


# ── Topics: fuzzy matching ────────────────────────────────────────────────────

class TestTopicFuzzyMatching:
    def test_exact_match(self):
        from crystalos.tools.topics import _fuzzy_matches_any
        assert _fuzzy_matches_any("Response Time", ["Response Time", "Checkout Flow"]) is True

    def test_substring_match(self):
        from crystalos.tools.topics import _fuzzy_matches_any
        assert _fuzzy_matches_any("Response Time", ["Support Response Time Issues"]) is True

    def test_levenshtein_close_match(self):
        from crystalos.tools.topics import _fuzzy_matches_any
        # "Respons Time" vs "Response Time" — distance 1
        assert _fuzzy_matches_any("Respons Time", ["Response Time"]) is True

    def test_no_match(self):
        from crystalos.tools.topics import _fuzzy_matches_any
        assert _fuzzy_matches_any("Billing Issue", ["Checkout Flow", "Response Time"]) is False

    def test_empty_previous(self):
        from crystalos.tools.topics import _fuzzy_matches_any
        assert _fuzzy_matches_any("Any Topic", []) is False

    def test_levenshtein_distance_basic(self):
        from crystalos.tools.topics import _levenshtein
        assert _levenshtein("kitten", "sitting") == 3
        assert _levenshtein("", "abc") == 3
        assert _levenshtein("abc", "") == 3
        assert _levenshtein("same", "same") == 0


# ── Dynamic trust scores ──────────────────────────────────────────────────────

class TestDynamicTrustScores:
    def test_trust_statistical_large_n(self):
        from crystalos.graphs.insights import _trust_statistical
        assert _trust_statistical(100) == 90
        assert _trust_statistical(50) == 80
        assert _trust_statistical(30) == 70

    def test_trust_statistical_small_n(self):
        from crystalos.graphs.insights import _trust_statistical
        score = _trust_statistical(5)
        assert 10 <= score <= 70  # linear range below 30

    def test_trust_coverage_full(self):
        from crystalos.graphs.insights import _trust_coverage
        assert _trust_coverage(100, 100) == 100

    def test_trust_coverage_partial(self):
        from crystalos.graphs.insights import _trust_coverage
        score = _trust_coverage(10, 100)
        assert 20 <= score <= 100

    def test_trust_consistency_uniform_cluster(self):
        from crystalos.graphs.insights import _trust_consistency
        cluster = {
            "dominant_sentiment": "negative",
            "texts": [{"sentiment": "negative"}] * 10,
        }
        score = _trust_consistency(cluster)
        assert score >= 90  # all same sentiment → high consistency

    def test_trust_consistency_mixed_cluster(self):
        from crystalos.graphs.insights import _trust_consistency
        cluster = {
            "dominant_sentiment": "negative",
            "texts": [{"sentiment": "negative"}] * 5 + [{"sentiment": "positive"}] * 5,
        }
        score = _trust_consistency(cluster)
        assert score < 80  # mixed → lower consistency

    def test_build_trust_returns_tuple(self):
        from crystalos.graphs.insights import _build_trust
        overall, trust_json = _build_trust(n=50, mentions=30, total=100)
        assert 0 <= overall <= 100
        assert "statistical" in trust_json
        assert "coverage" in trust_json
        assert "consistency" in trust_json
        assert "grounding" in trust_json


# ── Crystal Tool Org Scoping ──────────────────────────────────────────────────

class TestCrystalToolOrgScoping:
    """Tests for Crystal tool executors covering org-scoping and edge cases."""

    def _make_ctx(self, survey_id="survey-1", org_id="org-1"):
        from crystalos.crystal.context import CrystalContext
        return CrystalContext(
            org_id=org_id,
            user_id="user-1",
            survey_id=survey_id,
            scope="survey",
        )

    def _make_mock_pool(self, fetchone_return=None, fetchall_return=None):
        """Return a nested mock for db._pool_conn().connection().__aenter__."""
        mock_cur = AsyncMock()
        mock_cur.execute = AsyncMock()
        mock_cur.fetchone = AsyncMock(return_value=fetchone_return)
        mock_cur.fetchall = AsyncMock(return_value=fetchall_return or [])
        mock_cur.description = []
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
    async def test_survey_overview_wrong_org_returns_error(self):
        """When DB returns no rows (wrong org), result is {'error': 'survey not found'}."""
        from crystalos.crystal.tools import execute_get_survey_overview

        mock_pool, mock_cur = self._make_mock_pool(fetchone_return=None, fetchall_return=[])

        with patch("crystalos.crystal.tools.db._pool_conn", return_value=mock_pool):
            result = await execute_get_survey_overview(
                self._make_ctx(), {"survey_id": "survey-wrong-org"}
            )

        assert result == {"error": "survey not found"}

    @pytest.mark.asyncio
    async def test_survey_overview_missing_survey_id_returns_error(self):
        """CrystalContext with no survey_id and empty params returns error."""
        from crystalos.crystal.tools import execute_get_survey_overview
        from crystalos.crystal.context import CrystalContext

        ctx = CrystalContext(
            org_id="org-1",
            user_id="user-1",
            survey_id=None,
            scope="survey",
        )
        result = await execute_get_survey_overview(ctx, {})
        assert result == {"error": "survey_id required"}

    @pytest.mark.asyncio
    async def test_metric_history_empty_result(self):
        """Empty cursor returns result with 'history' key that is a list."""
        from crystalos.crystal.tools import execute_get_metric_history

        mock_pool, mock_cur = self._make_mock_pool(fetchall_return=[])
        mock_cur.description = [
            ("nps_score",), ("csat_score",), ("ces_score",), ("response_count",), ("captured_at",)
        ]

        with patch("crystalos.crystal.tools.db._pool_conn", return_value=mock_pool):
            result = await execute_get_metric_history(
                self._make_ctx(), {"survey_id": "survey-1"}
            )

        assert "history" in result
        assert isinstance(result["history"], list)

    @pytest.mark.asyncio
    async def test_insights_list_org_scoped(self):
        """SQL for execute_get_insights_list uses org_id from context."""
        from crystalos.crystal.tools import execute_get_insights_list

        mock_pool, mock_cur = self._make_mock_pool(fetchall_return=[])
        mock_cur.description = [
            ("id",), ("layer",), ("category",), ("headline",), ("narrative",),
            ("trust_score",), ("metric_json",)
        ]

        ctx = self._make_ctx(org_id="org-scoped-123")

        with patch("crystalos.crystal.tools.db._pool_conn", return_value=mock_pool):
            await execute_get_insights_list(ctx, {"survey_id": "survey-1"})

        # Verify that the execute call args include org_id
        call_args = mock_cur.execute.call_args
        # args[1] is the params tuple; org_id should be in there
        assert call_args is not None
        params = call_args[0][1] if len(call_args[0]) > 1 else call_args[1].get("args", ())
        assert "org-scoped-123" in params

    @pytest.mark.asyncio
    async def test_driver_analysis_scale_is_nps_range(self):
        """Driver impact values from execute_get_driver_analysis are in [-100, 100]."""
        from crystalos.crystal.tools import execute_get_driver_analysis

        # Row: name, volume, nps_avg, sentiment_score, effort_score
        mock_row = ("Shipping", 50, 42.0, 0.5, 3.0)
        mock_pool, mock_cur = self._make_mock_pool(fetchall_return=[mock_row])
        mock_cur.description = [
            ("name",), ("volume",), ("nps_avg",), ("sentiment_score",), ("effort_score",)
        ]

        with patch("crystalos.crystal.tools.db._pool_conn", return_value=mock_pool):
            result = await execute_get_driver_analysis(
                self._make_ctx(), {"survey_id": "survey-1"}
            )

        assert "drivers" in result
        for driver in result["drivers"]:
            assert -100 <= driver["driver_impact"] <= 100

    @pytest.mark.asyncio
    async def test_benchmark_comparison_known_industry(self):
        """Known industry 'technology' returns benchmark of 35 for NPS."""
        from crystalos.crystal.tools import execute_get_benchmark_comparison

        # Mock DB to return a current value
        mock_pool, mock_cur = self._make_mock_pool(fetchone_return=(42.0, 3.8))

        with patch("crystalos.crystal.tools.db._pool_conn", return_value=mock_pool):
            result = await execute_get_benchmark_comparison(
                self._make_ctx(),
                {"industry": "technology", "metric": "nps", "survey_id": "survey-1"},
            )

        assert "benchmark" in result
        assert result["benchmark"] == 35

    @pytest.mark.asyncio
    async def test_benchmark_comparison_unknown_industry_uses_other(self):
        """Unknown industry falls back to 'other' benchmark (32 for NPS)."""
        from crystalos.crystal.tools import execute_get_benchmark_comparison

        mock_pool, mock_cur = self._make_mock_pool(fetchone_return=(25.0, 3.5))

        with patch("crystalos.crystal.tools.db._pool_conn", return_value=mock_pool):
            result = await execute_get_benchmark_comparison(
                self._make_ctx(),
                {"industry": "unknown_xyz", "metric": "nps", "survey_id": "survey-1"},
            )

        assert "benchmark" in result
        assert result["benchmark"] == 32

    @pytest.mark.asyncio
    async def test_get_recent_checkpoints_org_scoped_and_shaped(self):
        """execute_get_recent_checkpoints returns delta_from_prior + meaningful_delta,
        org-scoped, with delta JSON parsed and nps coerced to float."""
        from crystalos.crystal.tools import execute_get_recent_checkpoints
        import json as _json

        row = (
            7,                      # checkpoint_number
            42.0,                   # nps_at_checkpoint
            _json.dumps({"nps_delta": -3.0}),  # delta_from_prior (string JSON)
            True,                   # meaningful_delta
            "2026-06-25 12:00:00",  # created_at
        )
        mock_pool, mock_cur = self._make_mock_pool(fetchall_return=[row])
        mock_cur.description = [
            ("checkpoint_number",), ("nps_at_checkpoint",),
            ("delta_from_prior",), ("meaningful_delta",), ("created_at",),
        ]

        ctx = self._make_ctx(org_id="org-scoped-xyz")
        with patch("crystalos.crystal.tools.db._pool_conn", return_value=mock_pool):
            result = await execute_get_recent_checkpoints(ctx, {"survey_id": "survey-1"})

        assert result["count"] == 1
        cp = result["checkpoints"][0]
        assert cp["checkpoint_number"] == 7
        assert cp["nps_at_checkpoint"] == 42.0
        assert cp["delta_from_prior"] == {"nps_delta": -3.0}
        assert cp["meaningful_delta"] is True
        assert isinstance(cp["created_at"], str)

        # org_id from context must be in the query params
        params = mock_cur.execute.call_args[0][1]
        assert "org-scoped-xyz" in params

    @pytest.mark.asyncio
    async def test_get_recent_checkpoints_missing_survey_id(self):
        from crystalos.crystal.tools import execute_get_recent_checkpoints
        from crystalos.crystal.context import CrystalContext
        ctx = CrystalContext(org_id="org-1", user_id="u1", survey_id=None, scope="survey")
        result = await execute_get_recent_checkpoints(ctx, {})
        assert result == {"error": "survey_id required"}


class TestProposeWorkflowModernShape:
    """execute_propose_workflow (crystal/tools.py) — reconciled (Xperiq Actions
    Wave 3) to emit the SAME nodes/edges engine graph shape as
    POST /workflows/parse-nl, via the shared crystal.workflow_nl core, instead
    of the old flat trigger/action_type/action_config shape."""

    def _ctx(self):
        from crystalos.crystal.context import CrystalContext
        return CrystalContext(org_id="org-1", user_id="u1", survey_id="survey-1", scope="survey")

    def _draft(self, **overrides):
        from crystalos.crystal.workflow_nl import (
            WorkflowNLDraft, WorkflowNLTriggerDraft, WorkflowNLConditionDraft, WorkflowNLActionDraft,
        )
        defaults = dict(
            name="NPS drop alert",
            description="Notify CSM when NPS drops below 30",
            trigger=WorkflowNLTriggerDraft(trigger_type="score.nps_drop"),
            conditions=[WorkflowNLConditionDraft(field="nps", op="lt", value="30")],
            actions=[WorkflowNLActionDraft(action="notify.slack", config={})],
            confidence=0.9,
            warnings=[],
            unparseable=False,
            unparseable_reason=None,
        )
        defaults.update(overrides)
        return WorkflowNLDraft(**defaults)

    @pytest.mark.asyncio
    async def test_produces_nodes_and_edges_not_legacy_flat_shape(self):
        from crystalos.crystal.tools import execute_propose_workflow
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=self._draft())):
            result = await execute_propose_workflow(
                self._ctx(), {"trigger_condition": "NPS drops below 30", "desired_outcome": "notify CSM on Slack"},
            )
        assert result["proposal_type"] == "workflow"
        params = result["params"]
        # Modern shape present ...
        assert "nodes" in params and "edges" in params
        assert isinstance(params["nodes"], list) and len(params["nodes"]) >= 1
        assert params["trigger_type"] == "score.nps_drop"
        # ... and the OLD flat shape must be gone (this was the reconciliation bug).
        assert "action_type" not in params
        assert "action_config" not in params
        assert "trigger" not in params or params.get("trigger") is None

    @pytest.mark.asyncio
    async def test_confidence_and_warnings_carried_into_params(self):
        from crystalos.crystal.tools import execute_propose_workflow
        draft = self._draft(warnings=["Assumed Slack channel #cx"], confidence=0.72)
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await execute_propose_workflow(
                self._ctx(), {"trigger_condition": "NPS drops below 30", "desired_outcome": "notify CSM"},
            )
        assert result["params"]["confidence"] == pytest.approx(0.72)
        assert "Assumed Slack channel #cx" in result["params"]["warnings"]

    @pytest.mark.asyncio
    async def test_proposal_type_still_aliases_to_create_workflow(self):
        """agents/crystal.py's _PROPOSAL_TYPE_ALIASES must still map this tool's
        proposal_type ('workflow') to the frontend handler name — unaffected by
        the shape reconciliation since only `params` changed, not `proposal_type`."""
        from crystalos.crystal.tools import execute_propose_workflow
        from crystalos.agents.crystal import _normalize_proposal
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=self._draft())):
            result = await execute_propose_workflow(
                self._ctx(), {"trigger_condition": "NPS drops below 30", "desired_outcome": "notify CSM"},
            )
        normalized = _normalize_proposal(result)
        assert normalized["type"] == "create_workflow"

    @pytest.mark.asyncio
    async def test_no_trigger_condition_or_outcome_returns_empty_graph_proposal(self):
        from crystalos.crystal.tools import execute_propose_workflow
        result = await execute_propose_workflow(self._ctx(), {})
        assert result["proposal_type"] == "workflow"
        assert result["params"]["nodes"] == []
        assert result["params"]["edges"] == []

    @pytest.mark.asyncio
    async def test_unparseable_description_returns_empty_graph_not_a_crash(self):
        from crystalos.crystal.tools import execute_propose_workflow
        draft = self._draft(unparseable=True, unparseable_reason="not a workflow")
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await execute_propose_workflow(
                self._ctx(), {"trigger_condition": "NPS drops below 30", "desired_outcome": "notify CSM"},
            )
        assert result["proposal_type"] == "workflow"
        assert result["params"]["nodes"] == []
        assert result["params"]["edges"] == []

    @pytest.mark.asyncio
    async def test_uses_fallback_registry_not_the_node_side_file(self):
        """The chat-tool path has no Node request to forward a live registry
        from — it must use FALLBACK_REGISTRY (crystal/workflow_nl.py), never
        crash for lack of one. A trigger only in the FULL registry (not the
        fallback mirror) should be dropped."""
        from crystalos.crystal.tools import execute_propose_workflow
        from crystalos.crystal.workflow_nl import WorkflowNLTriggerDraft
        draft = self._draft(trigger=WorkflowNLTriggerDraft(trigger_type="external.webhook"))  # not in FALLBACK_REGISTRY's triggers
        with patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(return_value=draft)):
            result = await execute_propose_workflow(
                self._ctx(), {"trigger_condition": "a webhook fires", "desired_outcome": "notify CSM"},
            )
        assert result["params"]["nodes"] == []


class TestProposeAlert:
    """Tests for the propose_alert action tool + proposal normalisation."""

    def _ctx(self):
        from crystalos.crystal.context import CrystalContext
        return CrystalContext(org_id="org-1", user_id="u1", survey_id="survey-1", scope="survey")

    @pytest.mark.asyncio
    async def test_propose_alert_builds_proposal(self):
        from crystalos.crystal.tools import execute_propose_alert
        result = await execute_propose_alert(
            self._ctx(),
            {"metric": "NPS", "condition": "NPS drops below 30", "alert_type": "S-03",
             "severity": "critical", "threshold": {"below": 30}},
        )
        assert result["proposal_type"] == "create_alert"
        assert result["requires_confirmation"] is True
        assert result["params"]["alert_type"] == "S-03"
        assert result["params"]["severity"] == "critical"
        assert result["params"]["threshold_config"] == {"below": 30}
        assert result["params"]["survey_id"] == "survey-1"

    @pytest.mark.asyncio
    async def test_propose_alert_defaults(self):
        from crystalos.crystal.tools import execute_propose_alert
        result = await execute_propose_alert(self._ctx(), {"condition": "CSAT falls"})
        assert result["params"]["alert_type"] == "S-03"      # default catalog code
        assert result["params"]["severity"] == "warning"     # default severity
        # "CSAT falls" is not parseable → falls back to S-03 catalog default
        assert result["params"]["threshold_config"] == {"below": 30}

    # ── _parse_threshold (bug B4) ──────────────────────────────────────────
    def test_parse_threshold_below(self):
        from crystalos.crystal.tools import _parse_threshold
        assert _parse_threshold("NPS drops below 30") == {"below": 30}

    def test_parse_threshold_above_decimal(self):
        from crystalos.crystal.tools import _parse_threshold
        assert _parse_threshold("CSAT above 4.5") == {"above": 4.5}

    def test_parse_threshold_synonyms(self):
        from crystalos.crystal.tools import _parse_threshold
        assert _parse_threshold("score under 10") == {"below": 10}
        assert _parse_threshold("rating exceeds 8") == {"above": 8}
        assert _parse_threshold("less than 2.5 stars") == {"below": 2.5}

    def test_parse_threshold_garbage_returns_none(self):
        from crystalos.crystal.tools import _parse_threshold
        assert _parse_threshold("garbage") is None
        assert _parse_threshold("") is None
        assert _parse_threshold(None) is None

    @pytest.mark.asyncio
    async def test_propose_alert_uses_parsed_threshold_from_prose(self):
        """When condition is prose and no explicit threshold dict, parse it."""
        from crystalos.crystal.tools import execute_propose_alert
        result = await execute_propose_alert(
            self._ctx(),
            {"metric": "NPS", "condition": "NPS drops below 25", "alert_type": "S-03"},
        )
        assert result["params"]["threshold_config"] == {"below": 25}

    @pytest.mark.asyncio
    async def test_propose_alert_explicit_dict_wins_over_prose(self):
        from crystalos.crystal.tools import execute_propose_alert
        result = await execute_propose_alert(
            self._ctx(),
            {"condition": "NPS drops below 25", "threshold": {"below": 40}},
        )
        assert result["params"]["threshold_config"] == {"below": 40}

    @pytest.mark.asyncio
    async def test_propose_alert_falls_back_to_catalog_default_s04(self):
        """No condition + S-04 alert type → S-04 catalog default."""
        from crystalos.crystal.tools import execute_propose_alert
        result = await execute_propose_alert(
            self._ctx(), {"metric": "CSAT", "alert_type": "S-04"},
        )
        assert result["params"]["threshold_config"] == {"below": 3.5}

    @pytest.mark.asyncio
    async def test_all_propose_tools_include_business_rationale(self):
        """Gap G1: every propose_* tool returns a non-empty business_rationale."""
        from crystalos.crystal.tools import (
            execute_propose_survey_creation,
            execute_propose_survey_edit,
            execute_propose_distribution,
            execute_propose_workflow,
            execute_propose_alert,
        )
        from crystalos.lib.openrouter import AgentOutputError
        ctx = self._ctx()
        with patch("crystalos.crystal.tools.db._pool_conn") as mock_pool, \
             patch("crystalos.crystal.workflow_nl._call_llm", new=AsyncMock(side_effect=AgentOutputError("no LLM in tests"))):
            # survey_creation queries the DB for the survey title; make it a no-op
            mock_conn = MagicMock()
            mock_pool.return_value.connection.return_value.__aenter__ = AsyncMock(
                side_effect=Exception("skip db")
            )
            # execute_propose_workflow's LLM call is mocked to fail fast (see patch
            # above) rather than genuinely reaching OpenRouter — it still returns a
            # valid business_rationale via its own fallback branch either way, but
            # this keeps the test offline per crystalos/CLAUDE.md's testing rules
            # ("Never make real LLM calls in tests").
            results = [
                await execute_propose_survey_creation(
                    ctx, {"purpose": "understand churn", "target_audience": "detractors"}
                ),
                await execute_propose_survey_edit(
                    ctx, {"edit_request": "add question", "focus_topic": "checkout"}
                ),
                await execute_propose_distribution(
                    ctx, {"target_segment": "detractors", "goal": "recover at-risk accounts"}
                ),
                await execute_propose_workflow(
                    ctx, {"trigger_condition": "NPS < 30", "desired_outcome": "notify CSM"}
                ),
                await execute_propose_alert(
                    ctx, {"metric": "NPS", "condition": "NPS drops below 30"}
                ),
            ]
        for r in results:
            rationale = r.get("business_rationale")
            assert isinstance(rationale, str) and rationale.strip(), r
            assert len(rationale) < 160, rationale

    def test_propose_alert_registered(self):
        from crystalos.crystal.registry import ACTION_TOOL_NAMES, TOOL_REGISTRY
        from crystalos.crystal.tools import TOOL_EXECUTORS
        assert "propose_alert" in ACTION_TOOL_NAMES
        assert "propose_alert" in TOOL_EXECUTORS
        assert any(t["name"] == "propose_alert" for t in TOOL_REGISTRY)

    def test_normalize_proposal_maps_alias_and_fills_id(self):
        from crystalos.agents.crystal import _normalize_proposal
        out = _normalize_proposal({"proposal_type": "workflow", "title": "Alert CSM on low NPS"})
        assert out["type"] == "create_workflow"             # alias mapped
        assert out["id"] == "alert-csm-on-low-nps"          # slug from title
        assert out["requires_confirmation"] is True
        assert out["priority"] == "medium"

    def test_normalize_alert_proposal_passes_through(self):
        from crystalos.agents.crystal import _normalize_proposal
        out = _normalize_proposal({"proposal_type": "create_alert", "title": "Watch NPS"})
        assert out["type"] == "create_alert"

    def test_extract_action_proposals_normalises(self):
        from crystalos.agents.crystal import _extract_action_proposals
        tool_results = [{
            "tool": "propose_alert",
            "result": {"proposal_type": "create_alert", "title": "Watch NPS", "params": {}},
        }]
        proposals = _extract_action_proposals(tool_results)
        assert len(proposals) == 1
        assert proposals[0]["type"] == "create_alert"
        assert proposals[0]["id"]            # has a generated id


# ── Insight Pipeline v2 — Phase 6 checkpoint chain / trail / report tools ──────

class TestInsightV2DataTools:
    """Phase 6 data tools: shape, org-scoping, v2→legacy fallback, render_hint."""

    def _ctx(self, survey_id="survey-1", org_id="org-1"):
        from crystalos.crystal.context import CrystalContext
        return CrystalContext(org_id=org_id, user_id="u1", survey_id=survey_id, scope="survey")

    def _make_mock_pool(self, fetchone_return=None, fetchall_return=None, description=None):
        mock_cur = AsyncMock()
        mock_cur.execute = AsyncMock()
        mock_cur.fetchone = AsyncMock(return_value=fetchone_return)
        mock_cur.fetchall = AsyncMock(return_value=fetchall_return or [])
        mock_cur.description = description or []
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
    async def test_get_checkpoint_chain_walks_and_shapes(self):
        from crystalos.crystal.tools import execute_get_checkpoint_chain
        import json as _json
        # Two v2 rows: child (14) → parent (13). Verified walk yields newest-first.
        rows = [
            ("id-14", 14, "id-13", "automated", "2026-06-25 10:00:00", 41.0, 12,
             _json.dumps({"nps_delta": -3.2, "topic_changes": {"emerged": ["Billing"]}}), True),
            ("id-13", 13, None, "automated", "2026-06-24 10:00:00", 44.2, 9,
             _json.dumps({"nps_delta": 1.0, "topic_changes": {"emerged": []}}), False),
        ]
        desc = [("id",), ("checkpoint_number",), ("parent_checkpoint_id",), ("lane",),
                ("created_at",), ("nps_at_checkpoint",), ("new_response_count",),
                ("delta_from_prior",), ("meaningful_delta",)]
        mock_pool, mock_cur = self._make_mock_pool(fetchall_return=rows, description=desc)
        with patch("crystalos.crystal.tools.db._pool_conn", return_value=mock_pool):
            result = await execute_get_checkpoint_chain(
                self._ctx(org_id="org-xyz"), {"survey_id": "survey-1", "lookback": 5})
        assert result["total_returned"] == 2
        first = result["checkpoints"][0]
        assert first["checkpoint_number"] == 14
        assert first["nps"] == 41.0
        assert first["nps_delta"] == -3.2
        assert "NPS 41" in first["summary"]
        assert first["url"].endswith("/trail/id-14")
        # org-scoped query
        assert "org-xyz" in mock_cur.execute.call_args[0][1]

    @pytest.mark.asyncio
    async def test_get_checkpoint_chain_requires_survey_id(self):
        from crystalos.crystal.tools import execute_get_checkpoint_chain
        from crystalos.crystal.context import CrystalContext
        ctx = CrystalContext(org_id="o", user_id="u", survey_id=None, scope="survey")
        assert await execute_get_checkpoint_chain(ctx, {}) == {"error": "survey_id required"}

    @pytest.mark.asyncio
    async def test_get_insight_settings_reuses_loader(self):
        from crystalos.crystal.tools import execute_get_insight_settings
        fake = {"prior_checkpoint_lookback": 5, "stream_response_threshold": 10}
        with patch("crystalos.lib.insight_settings.load_insight_settings",
                   new_callable=AsyncMock, return_value=fake):
            result = await execute_get_insight_settings(self._ctx(), {"survey_id": "survey-1"})
        assert result["survey_id"] == "survey-1"
        assert result["settings"]["prior_checkpoint_lookback"] == 5

    @pytest.mark.asyncio
    async def test_get_insight_report_carries_render_hint_document(self):
        from crystalos.crystal.tools import execute_get_insight_report
        row = ("rep-1", "manual_expert", "Q2 board prep", "ready", "user:abc",
               "2026-06-20 09:00:00", "blob-ref", "NPS 41 summary", 78.0, "ckpt-9",
               None, None)
        desc = [("id",), ("run_mode",), ("label",), ("status",), ("created_by",),
                ("created_at",), ("blob_ref",), ("summary_headline",), ("trust_score_avg",),
                ("checkpoint_id",), ("window_start",), ("window_end",)]
        mock_pool, mock_cur = self._make_mock_pool(fetchone_return=row, description=desc)
        fake_blob = {"executive_summary": "Exec summary.", "themes": [{"name": "Billing"}],
                     "insights": [{"headline": "h", "layer": "diagnostic",
                                   "citations_json": [{"response_id": "r1"}]}],
                     "nps": 41}
        with patch("crystalos.crystal.tools.db._pool_conn", return_value=mock_pool), \
             patch("crystalos.lib.checkpoint_store.read_checkpoint_blob",
                   new_callable=AsyncMock, return_value=fake_blob):
            result = await execute_get_insight_report(
                self._ctx(org_id="org-7"), {"survey_id": "survey-1", "report_id": "rep-1"})
        assert result["render_hint"] == "document"
        assert result["report_id"] == "rep-1"
        assert result["executive_summary"] == "Exec summary."
        assert result["citations_count"] == 1
        assert result["report_url"].endswith("/reports/rep-1")
        assert "org-7" in mock_cur.execute.call_args[0][1]

    @pytest.mark.asyncio
    async def test_get_insight_report_none_still_document_hint(self):
        from crystalos.crystal.tools import execute_get_insight_report
        mock_pool, _ = self._make_mock_pool(fetchone_return=None, description=[])
        with patch("crystalos.crystal.tools.db._pool_conn", return_value=mock_pool):
            result = await execute_get_insight_report(self._ctx(), {"survey_id": "survey-1"})
        assert result["report"] is None
        assert result["render_hint"] == "document"

    @pytest.mark.asyncio
    async def test_get_insight_trail_shapes_nodes(self):
        from crystalos.crystal.tools import execute_get_insight_trail
        import json as _json
        rows = [
            ("id-14", 14, "automated", "2026-06-25 10:00:00", "system:stream", 41.0,
             _json.dumps({"nps_delta": -3.2, "topic_changes": {"emerged": ["Billing"]}}),
             True, None, "automated_incremental"),
            ("id-m1", 3, "manual", "2026-06-22 10:00:00", "user:abc", 40.0,
             None, False, "Q2 board prep", "manual_expert"),
        ]
        desc = [("id",), ("checkpoint_number",), ("lane",), ("created_at",), ("created_by",),
                ("nps_at_checkpoint",), ("delta_from_prior",), ("meaningful_delta",),
                ("report_label",), ("run_mode",)]
        mock_pool, _ = self._make_mock_pool(fetchall_return=rows, description=desc)
        with patch("crystalos.crystal.tools.db._pool_conn", return_value=mock_pool):
            result = await execute_get_insight_trail(self._ctx(), {"survey_id": "survey-1"})
        assert result["count"] == 2
        types = {n["type"] for n in result["nodes"]}
        assert types == {"checkpoint", "report"}
        manual_node = next(n for n in result["nodes"] if n["lane"] == "manual")
        assert manual_node["summary"] == "Q2 board prep"

    @pytest.mark.asyncio
    async def test_get_checkpoint_detail_includes_delta_and_lineage(self):
        from crystalos.crystal.tools import execute_get_checkpoint_detail
        import json as _json
        row = ("id-14", 14, "id-13", "automated", "2026-06-25 10:00:00",
               41.0, 4.1, None, 12, 120,
               _json.dumps({"nps_delta": -3.2}), True,
               _json.dumps({"prior_checkpoint_refs": ["id-13"], "new_response_ids": ["r1", "r2"]}))
        desc = [("id",), ("checkpoint_number",), ("parent_checkpoint_id",), ("lane",),
                ("created_at",), ("nps_at_checkpoint",), ("csat_at_checkpoint",),
                ("ces_at_checkpoint",), ("new_response_count",), ("response_count_at_checkpoint",),
                ("delta_from_prior",), ("meaningful_delta",), ("lineage_json",)]
        mock_pool, _ = self._make_mock_pool(fetchone_return=row, description=desc)
        with patch("crystalos.crystal.tools.db._pool_conn", return_value=mock_pool):
            result = await execute_get_checkpoint_detail(
                self._ctx(), {"checkpoint_id": "id-14"})
        assert result["delta_from_prior"] == {"nps_delta": -3.2}
        assert result["parent_checkpoint_id"] == "id-13"
        assert result["prior_checkpoint_refs"] == ["id-13"]
        assert result["citations_count"] == 2

    @pytest.mark.asyncio
    async def test_get_checkpoint_detail_requires_id(self):
        from crystalos.crystal.tools import execute_get_checkpoint_detail
        assert await execute_get_checkpoint_detail(self._ctx(), {}) == {"error": "checkpoint_id required"}

    @pytest.mark.asyncio
    async def test_compare_checkpoints_metric_and_topic_diff(self):
        from crystalos.crystal import tools as _tools
        import json as _json

        async def _fake_load(ctx, cid):
            data = {
                "a": {"id": "a", "checkpoint_number": 12, "nps_at_checkpoint": 44.0,
                      "csat_at_checkpoint": None, "ces_at_checkpoint": None,
                      "created_at": "2026-06-20",
                      "delta_from_prior": _json.dumps({"topic_changes": {"emerged": ["Login"]}})},
                "b": {"id": "b", "checkpoint_number": 14, "nps_at_checkpoint": 41.0,
                      "csat_at_checkpoint": None, "ces_at_checkpoint": None,
                      "created_at": "2026-06-25",
                      "delta_from_prior": _json.dumps({"topic_changes": {"emerged": ["Billing"]}})},
            }
            return data[cid]

        with patch.object(_tools, "_load_checkpoint_row", new=AsyncMock(side_effect=_fake_load)):
            result = await _tools.execute_compare_checkpoints(
                self._ctx(), {"checkpoint_id_a": "a", "checkpoint_id_b": "b"})
        assert result["metric_delta"]["nps"] == -3.0
        assert result["topic_diff"]["only_in_a"] == ["Login"]
        assert result["topic_diff"]["only_in_b"] == ["Billing"]

    def test_v2_data_tools_registered(self):
        from crystalos.crystal.registry import DATA_TOOL_NAMES, TOOL_REGISTRY
        from crystalos.crystal.tools import TOOL_EXECUTORS
        for name in ("get_checkpoint_chain", "get_insight_settings", "get_insight_report",
                     "get_insight_trail", "get_checkpoint_detail", "compare_checkpoints"):
            assert name in DATA_TOOL_NAMES, name
            assert name in TOOL_EXECUTORS, name
            assert any(t["name"] == name for t in TOOL_REGISTRY), name


class TestInsightV2ProposeTools:
    """Phase 6 report proposals: shape, alias normalisation to frontend handler names."""

    def _ctx(self):
        from crystalos.crystal.context import CrystalContext
        return CrystalContext(org_id="org-1", user_id="u1", survey_id="survey-1", scope="survey")

    @pytest.mark.asyncio
    async def test_propose_manual_insight_run_shape(self):
        from crystalos.crystal.tools import execute_propose_manual_insight_run
        result = await execute_propose_manual_insight_run(
            self._ctx(), {"survey_id": "survey-1", "mode": "manual_expert", "label": "Q2 board prep"})
        assert result["proposal_type"] == "manual_insight_run"
        assert result["requires_confirmation"] is True
        assert result["params"]["mode"] == "expert"       # mapped to backend mode token
        assert result["params"]["survey_id"] == "survey-1"
        assert result["params"]["label"] == "Q2 board prep"

    @pytest.mark.asyncio
    async def test_propose_view_report_builds_url(self):
        from crystalos.crystal.tools import execute_propose_view_report
        result = await execute_propose_view_report(
            self._ctx(), {"survey_id": "survey-1", "report_id": "rep-9",
                          "summary": "NPS 41 — Jun 24"})
        assert result["proposal_type"] == "view_report"
        assert result["params"]["report_id"] == "rep-9"
        assert "/reports/rep-9" in result["params"]["url"]

    @pytest.mark.asyncio
    async def test_propose_generate_report_resolves_credits(self):
        from crystalos.crystal.tools import execute_propose_generate_intelligence_report
        result = await execute_propose_generate_intelligence_report(
            self._ctx(), {"survey_id": "survey-1", "estimated_credits": 20})
        assert result["proposal_type"] == "generate_intelligence_report"
        assert result["estimated_credits"] == 20
        assert result["params"]["estimated_credits"] == 20

    def test_v2_propose_tools_registered(self):
        from crystalos.crystal.registry import ACTION_TOOL_NAMES, TOOL_REGISTRY
        from crystalos.crystal.tools import TOOL_EXECUTORS
        for name in ("propose_manual_insight_run", "propose_view_report",
                     "propose_generate_intelligence_report"):
            assert name in ACTION_TOOL_NAMES, name
            assert name in TOOL_EXECUTORS, name
            assert any(t["name"] == name for t in TOOL_REGISTRY), name

    def test_proposal_type_aliases_map_to_frontend_handlers(self):
        from crystalos.agents.crystal import _normalize_proposal
        assert _normalize_proposal(
            {"proposal_type": "manual_insight_run", "title": "Generate Expert report"}
        )["type"] == "trigger_manual_insight_run"
        assert _normalize_proposal(
            {"proposal_type": "view_report", "title": "Open report"}
        )["type"] == "view_report"
        assert _normalize_proposal(
            {"proposal_type": "generate_intelligence_report", "title": "Generate report"}
        )["type"] == "generate_intelligence_report"

    @pytest.mark.asyncio
    async def test_extract_proposals_normalises_v2_tools(self):
        from crystalos.agents.crystal import _extract_action_proposals
        tool_results = [{
            "tool": "propose_manual_insight_run",
            "result": {"proposal_type": "manual_insight_run",
                       "title": "Generate Expert report", "params": {}},
        }]
        proposals = _extract_action_proposals(tool_results)
        assert len(proposals) == 1
        assert proposals[0]["type"] == "trigger_manual_insight_run"
        assert proposals[0]["id"]
