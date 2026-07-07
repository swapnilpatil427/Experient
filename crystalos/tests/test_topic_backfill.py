"""Unit tests for lib/topic_backfill.py — the manual "Backfill Tagging" job
orchestrator (Experience → Topics page). Mocks tag_untagged_responses directly
(it has its own full test suite in test_response_tagging.py) and a small
routing mock DB for status/count checks and agent_runs writeback.
"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from crystalos.lib.topic_backfill import run_topic_backfill, _MAX_NO_PROGRESS_CHUNKS, _count_untagged


# ── Mock DB plumbing ──────────────────────────────────────────────────────────
# Routes by SQL text. `remaining_sequence` is popped one value per COUNT(*)
# query — this is how tests simulate the backlog shrinking (or not) chunk by
# chunk without needing a real database.

class _BackfillCursor:
    def __init__(self, remaining_sequence, run_status="running", has_topics=True):
        self._remaining_sequence = list(remaining_sequence)
        self._run_status = run_status
        self._has_topics = has_topics
        self._last_fetchone = None
        self.execute_calls = []

    async def execute(self, sql, params=None):
        self.execute_calls.append((sql, params))
        if "COUNT(*)" in sql:
            value = self._remaining_sequence.pop(0) if self._remaining_sequence else 0
            self._last_fetchone = (value,)
        elif "SELECT status FROM agent_runs" in sql:
            self._last_fetchone = (self._run_status,)
        elif "survey_topic_centroids" in sql:
            self._last_fetchone = (1,) if self._has_topics else None

    async def fetchone(self):
        return self._last_fetchone

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _BackfillConn:
    def __init__(self, cursor):
        self._cursor = cursor
        self.executed = []

    def cursor(self):
        return self._cursor

    async def execute(self, sql, params=None):
        self.executed.append((sql, params))

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def _backfill_pool(remaining_sequence, run_status="running", has_topics=True):
    cur = _BackfillCursor(remaining_sequence, run_status, has_topics)
    conn = _BackfillConn(cur)
    pool = MagicMock()
    pool.connection = MagicMock(return_value=conn)
    return pool, conn


def _chunk(tagged=0, failed=0, quarantined=0, topics_assigned=0, topics_discovered=0):
    return {
        "tagged": tagged, "topics_assigned": topics_assigned, "topics_buffered": 0,
        "topics_discovered": topics_discovered, "skipped_no_survey": False, "failed": failed,
        "quarantined": quarantined,
    }


def _events_of_type(conn, event_type):
    """Parse every emitted stream_events UPDATE's JSON payload, filtered by event."""
    import json as _json
    out = []
    for sql, params in conn.executed:
        if "stream_events" in sql and params:
            payload = _json.loads(params[0])
            out.extend(e for e in payload if e.get("event") == event_type)
    return out


# ── Zero backlog ───────────────────────────────────────────────────────────────

class TestZeroBacklog:
    @pytest.mark.asyncio
    async def test_immediately_completes_when_nothing_untagged(self):
        pool, conn = _backfill_pool(remaining_sequence=[0])
        tag_mock = AsyncMock()

        with (
            patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool),
            patch("crystalos.lib.topic_backfill.tag_untagged_responses", tag_mock),
        ):
            await run_topic_backfill("run-1", "s1", "o1")

        tag_mock.assert_not_called()
        completed_calls = [c for c in conn.executed if "status='completed'" in c[0] or "status=%s" in c[0]]
        assert len(completed_calls) == 1
        assert completed_calls[0][1] == ("completed", "run-1")


# ── Successful multi-chunk drain ───────────────────────────────────────────────

class TestSuccessfulDrain:
    @pytest.mark.asyncio
    async def test_loops_until_backlog_clears_then_marks_completed(self):
        # Backlog: 120 → after chunk 1: 70 → after chunk 2: 0
        pool, conn = _backfill_pool(remaining_sequence=[120, 70, 0])
        tag_mock = AsyncMock(side_effect=[_chunk(tagged=50), _chunk(tagged=70)])

        with (
            patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool),
            patch("crystalos.lib.topic_backfill.tag_untagged_responses", tag_mock),
            patch("crystalos.lib.topic_backfill.asyncio.sleep", AsyncMock()),
        ):
            await run_topic_backfill("run-1", "s1", "o1")

        assert tag_mock.await_count == 2
        status_updates = [c[1] for c in conn.executed if "status=%s" in c[0]]
        assert ("completed", "run-1") in status_updates

    @pytest.mark.asyncio
    async def test_stops_when_run_is_cancelled_externally(self):
        """If a user (or the zombie sweep) marks the run cancelled/failed while a
        chunk is in flight, the loop must stop instead of doing more billed work
        nobody is waiting on — checked at the top of every iteration."""
        pool, conn = _backfill_pool(remaining_sequence=[120], run_status="cancelled")
        tag_mock = AsyncMock()

        with (
            patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool),
            patch("crystalos.lib.topic_backfill.tag_untagged_responses", tag_mock),
        ):
            await run_topic_backfill("run-1", "s1", "o1")

        tag_mock.assert_not_called()  # never even started a chunk
        # Must NOT overwrite the status the canceller already set.
        status_updates = [c for c in conn.executed if "status=%s" in c[0]]
        assert status_updates == []

    @pytest.mark.asyncio
    async def test_passes_include_retriable_so_quarantined_responses_get_another_attempt(self):
        """This orchestrator is the ONLY caller allowed to ask
        tag_untagged_responses to retry quarantined responses (2026-07-14) —
        a manual, user-initiated backfill click is the one deliberate point
        where re-attempting a response that repeatedly failed automatic
        tagging is safe; the automatic stream/scheduler sweep must never do
        this itself."""
        pool, conn = _backfill_pool(remaining_sequence=[10, 0])
        tag_mock = AsyncMock(return_value=_chunk(tagged=10))

        with (
            patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool),
            patch("crystalos.lib.topic_backfill.tag_untagged_responses", tag_mock),
            patch("crystalos.lib.topic_backfill.asyncio.sleep", AsyncMock()),
        ):
            await run_topic_backfill("run-1", "s1", "o1")

        tag_mock.assert_awaited_once_with(
            "s1", "o1", max_batch=50, include_retriable=True, has_centroids=True,
        )


# ── _count_untagged: retriable (quarantined) responses count too ──────────────

class TestCountUntaggedIncludesRetriable:
    @pytest.mark.asyncio
    async def test_count_query_also_selects_quarantined_responses_missing_scores(self):
        """Regression test (2026-07-14): a survey with a quarantined response
        (ai_enriched_at set, but ai_sentiment/ai_emotion/ai_effort_score still
        NULL because every automatic attempt failed) used to report a backlog
        of 0 here — this job's own count and backend/src/routes/insights.ts's
        pre-check both used ai_enriched_at IS NULL alone, so a manual Catch Up
        Tagging click would report "nothing to backfill" while that response
        sat with permanently-missing scores. Must also exclude
        ai_no_scorable_text — that's a terminal "nothing to score" state, not
        a retriable failure."""
        cur = _BackfillCursor(remaining_sequence=[3])
        conn = _BackfillConn(cur)
        pool = MagicMock()
        pool.connection = MagicMock(return_value=conn)

        with patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool):
            count = await _count_untagged("s1", "o1")

        assert count == 3
        count_calls = [c for c in cur.execute_calls if "COUNT(*)" in c[0]]
        assert len(count_calls) == 1
        sql = count_calls[0][0]
        assert "ai_enriched_at IS NULL" in sql
        assert "ai_enriched_at IS NOT NULL AND ai_no_scorable_text = FALSE" in sql
        assert "ai_sentiment IS NULL OR ai_emotion IS NULL OR ai_effort_score IS NULL" in sql

    @pytest.mark.asyncio
    async def test_count_query_also_selects_topic_orphans_when_centroids_exist(self):
        """Regression test (2026-07-14) for the actual customer-reported bug:
        a survey fully sentiment/emotion/effort-tagged but with zero topics
        (e.g. swept before centroids existed) used to report a backlog of 0
        here forever — Catch Up Tagging would say "nothing to backfill" while
        every response's Topics column stayed permanently empty."""
        cur = _BackfillCursor(remaining_sequence=[7])
        conn = _BackfillConn(cur)
        pool = MagicMock()
        pool.connection = MagicMock(return_value=conn)

        with patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool):
            count = await _count_untagged("s1", "o1", has_centroids=True)

        assert count == 7
        sql = cur.execute_calls[0][0]
        assert "ai_topics IS NULL" in sql
        # Plain caller-supplied boolean, not a fresh per-row subquery (fixed
        # 2026-07-14, self-review finding) — run_topic_backfill already knows
        # this once per run via _has_topics_yet; re-deriving it here on every
        # chunk's COUNT(*) scan would be redundant.
        assert "EXISTS" not in sql
        assert "survey_topic_centroids" not in sql

    @pytest.mark.asyncio
    async def test_count_query_omits_topic_orphan_clause_when_centroids_dont_exist(self):
        cur = _BackfillCursor(remaining_sequence=[3])
        conn = _BackfillConn(cur)
        pool = MagicMock()
        pool.connection = MagicMock(return_value=conn)

        with patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool):
            await _count_untagged("s1", "o1", has_centroids=False)

        sql = cur.execute_calls[0][0]
        assert "ai_topics" not in sql


# ── Stall detection (safety valve) ─────────────────────────────────────────────

class TestStallDetection:
    @pytest.mark.asyncio
    async def test_marks_failed_after_max_no_progress_chunks(self):
        # Remaining count never decreases — simulates a bug that isn't caught by
        # tag_untagged_responses's own quarantine circuit breaker.
        remaining_sequence = [100] * (_MAX_NO_PROGRESS_CHUNKS + 2)
        pool, conn = _backfill_pool(remaining_sequence=remaining_sequence)
        tag_mock = AsyncMock(return_value=_chunk())  # zero progress every chunk

        with (
            patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool),
            patch("crystalos.lib.topic_backfill.tag_untagged_responses", tag_mock),
            patch("crystalos.lib.topic_backfill.asyncio.sleep", AsyncMock()),
        ):
            await run_topic_backfill("run-1", "s1", "o1")

        assert tag_mock.await_count == _MAX_NO_PROGRESS_CHUNKS
        status_updates = [c[1] for c in conn.executed if "status=%s" in c[0]]
        assert ("failed", "run-1") in status_updates

    @pytest.mark.asyncio
    async def test_orphan_only_progress_is_not_a_false_stall(self):
        """Regression test (2026-07-14): a chunk that ONLY fixes topic orphans
        (already sentiment/emotion/effort-scored, so tagged=0) but assigns
        topics to them must count as real progress. Before this fix,
        chunk_activity only looked at tagged/quarantined — a backlog made
        entirely of orphans would show zero activity every single chunk even
        while genuinely shrinking, and the stall valve would wrongly mark a
        healthy run 'failed'."""
        remaining_sequence = [40, 20, 0]
        pool, conn = _backfill_pool(remaining_sequence=remaining_sequence)
        tag_mock = AsyncMock(side_effect=[
            _chunk(tagged=0, topics_assigned=20),
            _chunk(tagged=0, topics_assigned=20),
        ])

        with (
            patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool),
            patch("crystalos.lib.topic_backfill.tag_untagged_responses", tag_mock),
            patch("crystalos.lib.topic_backfill.asyncio.sleep", AsyncMock()),
        ):
            await run_topic_backfill("run-1", "s1", "o1")

        status_updates = [c[1] for c in conn.executed if "status=%s" in c[0]]
        assert ("completed", "run-1") in status_updates
        assert ("failed", "run-1") not in status_updates

    @pytest.mark.asyncio
    async def test_active_survey_with_flat_remaining_count_is_not_a_false_stall(self):
        """Regression test (2026-07-13, independent review finding): stall
        detection used to compare the raw `remaining` count between chunks. On
        a survey that's still actively collecting responses, new arrivals can
        keep `remaining` flat (or rising) even while every chunk is
        successfully draining real backlog — this used to false-trip the
        valve into marking a perfectly healthy backfill 'failed'. Detection
        must be based on whether THIS chunk did real work (tagged/quarantined
        something), not on the live count, which other traffic can move
        independently of this job."""
        # remaining stays exactly 100 for _MAX_NO_PROGRESS_CHUNKS chunks (new
        # arrivals backfilling what this job just cleared) before finally
        # draining to 0 — this would have failed under the old remaining-based
        # check, since remaining never visibly decreases until the last chunk.
        remaining_sequence = [100] * _MAX_NO_PROGRESS_CHUNKS + [0]
        pool, conn = _backfill_pool(remaining_sequence=remaining_sequence)
        tag_mock = AsyncMock(return_value=_chunk(tagged=20))  # real work every single chunk

        with (
            patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool),
            patch("crystalos.lib.topic_backfill.tag_untagged_responses", tag_mock),
            patch("crystalos.lib.topic_backfill.asyncio.sleep", AsyncMock()),
        ):
            await run_topic_backfill("run-1", "s1", "o1")

        status_updates = [c[1] for c in conn.executed if "status=%s" in c[0]]
        assert ("completed", "run-1") in status_updates
        assert ("failed", "run-1") not in status_updates

    @pytest.mark.asyncio
    async def test_progress_resets_the_no_progress_counter(self):
        """A single stalled chunk sandwiched between two progressing chunks must
        not accumulate toward the stall threshold — only CONSECUTIVE no-progress
        chunks count."""
        # 100 -> 100 (stall) -> 50 (progress, resets counter) -> 0 (done)
        pool, conn = _backfill_pool(remaining_sequence=[100, 100, 50, 0])
        tag_mock = AsyncMock(side_effect=[_chunk(), _chunk(tagged=50), _chunk(tagged=50)])

        with (
            patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool),
            patch("crystalos.lib.topic_backfill.tag_untagged_responses", tag_mock),
            patch("crystalos.lib.topic_backfill.asyncio.sleep", AsyncMock()),
        ):
            await run_topic_backfill("run-1", "s1", "o1")

        status_updates = [c[1] for c in conn.executed if "status=%s" in c[0]]
        assert ("completed", "run-1") in status_updates
        assert ("failed", "run-1") not in status_updates


# ── Honest completion reporting (quarantined responses) ───────────────────────

class TestHonestCompletionReporting:
    @pytest.mark.asyncio
    async def test_quarantined_responses_are_surfaced_not_silently_folded_into_complete(self):
        """Regression test (2026-07-13, independent review finding): quarantined
        responses (permanently skipped after repeated failures) make `remaining`
        reach 0 just like normally-tagged ones, since quarantine also sets
        ai_enriched_at. Reporting a flat 'complete' without ever mentioning them
        would let a customer trust topic/NPS analysis that's silently missing
        real response data. `quarantined` must be tracked separately from
        `processed` and always present in the completion event."""
        pool, conn = _backfill_pool(remaining_sequence=[100, 0])
        tag_mock = AsyncMock(side_effect=[_chunk(tagged=95, quarantined=5)])

        with (
            patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool),
            patch("crystalos.lib.topic_backfill.tag_untagged_responses", tag_mock),
            patch("crystalos.lib.topic_backfill.asyncio.sleep", AsyncMock()),
        ):
            await run_topic_backfill("run-1", "s1", "o1")

        complete_events = _events_of_type(conn, "backfill_complete")
        assert len(complete_events) == 1
        data = complete_events[0]["data"]
        assert data["processed"] == 95
        assert data["quarantined"] == 5

    @pytest.mark.asyncio
    async def test_quarantine_count_accumulates_across_multiple_chunks(self):
        pool, conn = _backfill_pool(remaining_sequence=[100, 50, 0])
        tag_mock = AsyncMock(side_effect=[
            _chunk(tagged=45, quarantined=5),
            _chunk(tagged=48, quarantined=2),
        ])

        with (
            patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool),
            patch("crystalos.lib.topic_backfill.tag_untagged_responses", tag_mock),
            patch("crystalos.lib.topic_backfill.asyncio.sleep", AsyncMock()),
        ):
            await run_topic_backfill("run-1", "s1", "o1")

        complete_events = _events_of_type(conn, "backfill_complete")
        assert complete_events[0]["data"]["quarantined"] == 7
        assert complete_events[0]["data"]["processed"] == 93


# ── Bootstrap-gap disclosure ────────────────────────────────────────────────────
# The single highest-severity finding from the independent customer/backend
# review (2026-07-13): this job can only ASSIGN/discover topics once a survey
# already has at least one — a survey's first-ever topic set only comes from
# the full pipeline's bootstrap run, which the platform only auto-triggers for
# active/paused surveys. A closed/draft survey a customer just imported
# historical responses into would never get topics through this job alone,
# which used to still report "Backfill complete" with no signal that topics
# structurally could not have been produced.

class TestBootstrapGapDisclosure:
    @pytest.mark.asyncio
    async def test_flags_bootstrap_pending_when_survey_has_no_topics_yet(self):
        pool, conn = _backfill_pool(remaining_sequence=[50, 0], has_topics=False)
        tag_mock = AsyncMock(return_value=_chunk(tagged=50))

        with (
            patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool),
            patch("crystalos.lib.topic_backfill.tag_untagged_responses", tag_mock),
            patch("crystalos.lib.topic_backfill.asyncio.sleep", AsyncMock()),
        ):
            await run_topic_backfill("run-1", "s1", "o1")

        started = _events_of_type(conn, "backfill_started")
        complete = _events_of_type(conn, "backfill_complete")
        assert started[0]["data"]["bootstrap_pending"] is True
        assert complete[0]["data"]["bootstrap_pending"] is True

    @pytest.mark.asyncio
    async def test_does_not_flag_bootstrap_pending_when_topics_already_exist(self):
        pool, conn = _backfill_pool(remaining_sequence=[50, 0], has_topics=True)
        tag_mock = AsyncMock(return_value=_chunk(tagged=50))

        with (
            patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool),
            patch("crystalos.lib.topic_backfill.tag_untagged_responses", tag_mock),
            patch("crystalos.lib.topic_backfill.asyncio.sleep", AsyncMock()),
        ):
            await run_topic_backfill("run-1", "s1", "o1")

        complete = _events_of_type(conn, "backfill_complete")
        assert complete[0]["data"]["bootstrap_pending"] is False

    @pytest.mark.asyncio
    async def test_flags_bootstrap_pending_even_on_the_zero_backlog_fast_path(self):
        """A closed survey with zero UNTAGGED responses (everything already has
        sentiment/emotion from a prior sweep, but never got topics) must still
        be flagged — the zero-backlog early return is a real, common way to
        reach this state, not just the multi-chunk path."""
        pool, conn = _backfill_pool(remaining_sequence=[0], has_topics=False)
        tag_mock = AsyncMock()

        with (
            patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool),
            patch("crystalos.lib.topic_backfill.tag_untagged_responses", tag_mock),
        ):
            await run_topic_backfill("run-1", "s1", "o1")

        tag_mock.assert_not_called()
        complete = _events_of_type(conn, "backfill_complete")
        assert complete[0]["data"]["bootstrap_pending"] is True

    @pytest.mark.asyncio
    async def test_has_topics_check_failure_fails_open_and_does_not_crash_the_job(self):
        """A transient error checking has_centroids must not block or mislabel
        a real run — fail open (treat as "has topics") rather than raising."""
        from crystalos.lib.topic_backfill import _has_topics_yet

        pool = MagicMock()
        pool.connection = MagicMock(side_effect=RuntimeError("pool exhausted"))
        with patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool):
            result = await _has_topics_yet("s1")
        assert result is True


# ── Unexpected exception ───────────────────────────────────────────────────────

class TestUnexpectedException:
    @pytest.mark.asyncio
    async def test_uncaught_exception_marks_run_failed_not_left_running_forever(self):
        pool, conn = _backfill_pool(remaining_sequence=[100])
        tag_mock = AsyncMock(side_effect=RuntimeError("boom"))

        with (
            patch("crystalos.lib.topic_backfill.db._pool_conn", return_value=pool),
            patch("crystalos.lib.topic_backfill.tag_untagged_responses", tag_mock),
        ):
            await run_topic_backfill("run-1", "s1", "o1")  # must not raise

        status_updates = [c[1] for c in conn.executed if "status=%s" in c[0]]
        assert ("failed", "run-1") in status_updates
