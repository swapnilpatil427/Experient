"""Unit tests for topic_registry helpers and batch async functions."""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from crystalos.lib.topic_registry import (
    ASSIGNMENT_THRESHOLD,
    _compute_health_label,
    _format_vector,
    _parse_vector,
    add_candidates_batch,
    assign_batch_to_nearest,
    dedupe_unassigned_to_one_per_response,
    group_assignments_by_response,
    update_centroids_welford_batch,
)


# ── _parse_vector / _format_vector ────────────────────────────────────────────

class TestVectorHelpers:
    def test_parse_string_literal(self):
        assert _parse_vector("[1.0,2.0,3.0]") == pytest.approx([1.0, 2.0, 3.0])

    def test_parse_python_list(self):
        assert _parse_vector([0.1, 0.2]) == pytest.approx([0.1, 0.2])

    def test_parse_none_returns_none(self):
        assert _parse_vector(None) is None

    def test_parse_invalid_string_returns_none(self):
        assert _parse_vector("not_a_vector") is None

    def test_format_produces_bracket_string(self):
        formatted = _format_vector([0.1, 0.2, 0.3])
        assert formatted.startswith("[") and formatted.endswith("]")

    def test_roundtrip(self):
        original = [0.123, -0.456, 0.789]
        parsed = _parse_vector(_format_vector(original))
        assert parsed == pytest.approx(original)


# ── _compute_health_label ─────────────────────────────────────────────────────

class TestComputeHealthLabel:
    def test_first_window_is_emerging(self):
        assert _compute_health_label(10, 0.5, None, None, is_first_window=True) == "emerging"

    def test_no_prior_count_is_emerging(self):
        assert _compute_health_label(10, 0.5, None, None, is_first_window=False) == "emerging"

    def test_zero_prior_count_is_emerging(self):
        assert _compute_health_label(5, 0.0, 0, 0.0, is_first_window=False) == "emerging"

    def test_growing_above_25_pct(self):
        # 130 vs 100 = +30% > 25%
        assert _compute_health_label(130, 0.5, 100, 0.4, is_first_window=False) == "growing"

    def test_fading_below_minus_30_pct(self):
        # 60 vs 100 = -40% < -30%
        assert _compute_health_label(60, 0.5, 100, 0.4, is_first_window=False) == "fading"

    def test_worsening_on_sentiment_drop(self):
        # Stable volume, sentiment drops > 0.15
        assert _compute_health_label(100, -0.1, 100, 0.2, is_first_window=False) == "worsening"

    def test_stable_when_no_signal(self):
        assert _compute_health_label(100, 0.3, 100, 0.3, is_first_window=False) == "stable"

    def test_growing_takes_priority_over_worsening(self):
        # Volume grew >25% AND sentiment worsened >0.15 → "growing" wins
        # (volume change checked first in the implementation)
        assert _compute_health_label(130, -0.5, 100, 0.2, is_first_window=False) == "growing"


# ── assign_batch_to_nearest ───────────────────────────────────────────────────

class TestAssignBatchToNearest:
    @pytest.mark.asyncio
    async def test_empty_embeddings_returns_empty(self):
        conn = AsyncMock()
        assignments, unassigned = await assign_batch_to_nearest({}, "s1", conn)
        assert assignments == {}
        assert unassigned == []

    @pytest.mark.asyncio
    async def test_no_centroids_all_unassigned(self):
        with patch("crystalos.lib.topic_registry.get_centroids", return_value=[]):
            conn = AsyncMock()
            assignments, unassigned = await assign_batch_to_nearest(
                {"r1": [0.1, 0.2], "r2": [0.3, 0.4]}, "s1", conn
            )
        assert assignments == {}
        assert set(unassigned) == {"r1", "r2"}

    @pytest.mark.asyncio
    async def test_assigns_above_threshold(self):
        import math
        # topic_a centroid = [1, 0], topic_b = [0, 1]
        # r1 embedding is nearly [1, 0] → assigned to topic_a
        emb = [0.999, 0.045]
        norm = math.sqrt(sum(x**2 for x in emb))
        emb = [x / norm for x in emb]

        centroids = [
            {"topic_name": "topic_a", "centroid": [1.0, 0.0], "response_count": 10},
            {"topic_name": "topic_b", "centroid": [0.0, 1.0], "response_count": 5},
        ]
        with patch("crystalos.lib.topic_registry.get_centroids", return_value=centroids):
            conn = AsyncMock()
            assignments, unassigned = await assign_batch_to_nearest(
                {"r1": emb}, "s1", conn, threshold=0.7
            )
        assert assignments.get("r1") == "topic_a"
        assert "r1" not in unassigned

    @pytest.mark.asyncio
    async def test_unassigned_when_below_threshold(self):
        # Embedding orthogonal to all centroids → dot product = 0 < 0.72
        centroids = [{"topic_name": "topic_a", "centroid": [1.0, 0.0, 0.0], "response_count": 5}]
        with patch("crystalos.lib.topic_registry.get_centroids", return_value=centroids):
            conn = AsyncMock()
            assignments, unassigned = await assign_batch_to_nearest(
                {"r1": [0.0, 1.0, 0.0]}, "s1", conn, threshold=ASSIGNMENT_THRESHOLD
            )
        assert "r1" not in assignments
        assert "r1" in unassigned

    @pytest.mark.asyncio
    async def test_multiple_responses_assigned_correctly(self):
        # r1 is close to topic_a, r2 is close to topic_b
        centroids = [
            {"topic_name": "topic_a", "centroid": [1.0, 0.0], "response_count": 5},
            {"topic_name": "topic_b", "centroid": [0.0, 1.0], "response_count": 5},
        ]
        with patch("crystalos.lib.topic_registry.get_centroids", return_value=centroids):
            conn = AsyncMock()
            assignments, unassigned = await assign_batch_to_nearest(
                {"r1": [0.99, 0.14], "r2": [0.14, 0.99]},
                "s1", conn, threshold=0.0,  # accept any positive similarity
            )
        assert assignments.get("r1") == "topic_a"
        assert assignments.get("r2") == "topic_b"


# ── Multi-topic-per-response regrouping helpers (added 2026-07-06) ────────────
# assign_batch_to_nearest itself is unchanged and key-agnostic (proven above by
# using plain "r1"/"r2" keys) — these helpers let callers pass composite
# "response_id::question_id" keys so a response with multiple open-text
# answers can match multiple different existing topics, then regroup the
# per-answer results back to per-response shape.

class TestGroupAssignmentsByResponse:
    def test_single_answer_per_response(self):
        assignments = {"r1::q1": "Shipping Costs"}
        assert group_assignments_by_response(assignments) == {"r1": ["Shipping Costs"]}

    def test_two_different_answers_same_response_two_topics(self):
        assignments = {"r1::q1": "Shipping Costs", "r1::q2": "Support Quality"}
        result = group_assignments_by_response(assignments)
        assert result == {"r1": ["Shipping Costs", "Support Quality"]}

    def test_two_answers_same_response_same_topic_deduped(self):
        assignments = {"r1::q1": "Shipping Costs", "r1::q2": "Shipping Costs"}
        result = group_assignments_by_response(assignments)
        assert result == {"r1": ["Shipping Costs"]}

    def test_multiple_responses_kept_independent(self):
        assignments = {"r1::q1": "Shipping Costs", "r2::q1": "Support Quality"}
        result = group_assignments_by_response(assignments)
        assert result == {"r1": ["Shipping Costs"], "r2": ["Support Quality"]}

    def test_empty_assignments_returns_empty(self):
        assert group_assignments_by_response({}) == {}


class TestDedupeUnassignedToOnePerResponse:
    def test_single_unassigned_answer(self):
        embeddings = {"r1::q1": [0.1, 0.2]}
        result = dedupe_unassigned_to_one_per_response(["r1::q1"], embeddings)
        assert result == [("r1", [0.1, 0.2])]

    def test_multiple_unassigned_answers_same_response_keeps_only_first(self):
        """topic_candidates has UNIQUE(survey_id, response_id) — only one
        candidate slot per response, so a response with 2 unmatched answers
        must not produce 2 candidate rows."""
        embeddings = {"r1::q1": [0.1, 0.2], "r1::q2": [0.9, 0.8]}
        result = dedupe_unassigned_to_one_per_response(["r1::q1", "r1::q2"], embeddings)
        assert result == [("r1", [0.1, 0.2])]  # first-seen wins

    def test_different_responses_each_get_a_candidate(self):
        embeddings = {"r1::q1": [0.1, 0.2], "r2::q1": [0.5, 0.6]}
        result = dedupe_unassigned_to_one_per_response(["r1::q1", "r2::q1"], embeddings)
        assert result == [("r1", [0.1, 0.2]), ("r2", [0.5, 0.6])]

    def test_empty_list_returns_empty(self):
        assert dedupe_unassigned_to_one_per_response([], {}) == []


# ── Welford batch math ────────────────────────────────────────────────────────
# We test the formula directly rather than mocking the psycopg3 cursor chain.

class TestWelfordBatchMath:
    def _welford_batch(self, old_vec, old_count, new_embeddings):
        """Inline formula from update_centroids_welford_batch."""
        k = len(new_embeddings)
        new_count = old_count + k
        new_vec = [
            (old_vec[i] * old_count + sum(emb[i] for emb in new_embeddings)) / new_count
            for i in range(len(old_vec))
        ]
        return new_vec, new_count

    def test_single_new_embedding(self):
        new_vec, new_count = self._welford_batch([1.0, 0.0], 4, [[0.0, 1.0]])
        # (1.0*4 + 0) / 5 = 0.8, (0.0*4 + 1) / 5 = 0.2
        assert new_vec == pytest.approx([0.8, 0.2])
        assert new_count == 5

    def test_multiple_new_embeddings(self):
        new_vec, new_count = self._welford_batch(
            [1.0, 0.0], 2, [[0.0, 1.0], [0.0, 1.0]]
        )
        # (1.0*2 + 0+0) / 4 = 0.5, (0.0*2 + 1+1) / 4 = 0.5
        assert new_vec == pytest.approx([0.5, 0.5])
        assert new_count == 4

    def test_same_embedding_moves_centroid_toward_it(self):
        # Old centroid [1, 0] with count=1, add [0, 1] twice → [1/3, 2/3]
        new_vec, _ = self._welford_batch([1.0, 0.0], 1, [[0.0, 1.0], [0.0, 1.0]])
        assert new_vec[0] == pytest.approx(1.0 / 3.0, abs=1e-9)
        assert new_vec[1] == pytest.approx(2.0 / 3.0, abs=1e-9)

    def test_adding_identical_embeddings_is_idempotent_to_centroid(self):
        # Old centroid = [0.5, 0.5], add same vector [0.5, 0.5] — centroid should not change
        new_vec, new_count = self._welford_batch([0.5, 0.5], 10, [[0.5, 0.5]])
        assert new_vec == pytest.approx([0.5, 0.5])
        assert new_count == 11

    def test_empty_new_embeddings_noop(self):
        old = [0.3, 0.7]
        new_vec, new_count = self._welford_batch(old, 5, [])
        assert new_count == 5
        assert new_vec == pytest.approx(old)


# ── add_candidates_batch ──────────────────────────────────────────────────────

class TestAddCandidatesBatch:
    @pytest.mark.asyncio
    async def test_empty_pairs_does_not_touch_conn(self):
        conn = AsyncMock()
        await add_candidates_batch("s1", "org1", [], conn)
        conn.cursor.assert_not_called()

    @pytest.mark.asyncio
    async def test_calls_executemany_with_correct_row_count(self):
        cur = AsyncMock()
        cur.__aenter__ = AsyncMock(return_value=cur)
        cur.__aexit__ = AsyncMock(return_value=None)
        conn = MagicMock()
        conn.cursor = MagicMock(return_value=cur)

        pairs = [("r1", [0.1, 0.2]), ("r2", [0.3, 0.4]), ("r3", [0.5, 0.6])]
        await add_candidates_batch("s1", "org1", pairs, conn)

        cur.executemany.assert_called_once()
        sql, rows = cur.executemany.call_args[0]
        assert len(rows) == 3

    @pytest.mark.asyncio
    async def test_row_contains_survey_and_response_ids(self):
        cur = AsyncMock()
        cur.__aenter__ = AsyncMock(return_value=cur)
        cur.__aexit__ = AsyncMock(return_value=None)
        conn = MagicMock()
        conn.cursor = MagicMock(return_value=cur)

        await add_candidates_batch("survey-x", "org-y", [("resp-z", [1.0, 0.0])], conn)

        _, rows = cur.executemany.call_args[0]
        survey_id, org_id, response_id, emb_str = rows[0]
        assert survey_id == "survey-x"
        assert org_id == "org-y"
        assert response_id == "resp-z"
        # Embedding is formatted as pgvector string
        assert emb_str.startswith("[")
