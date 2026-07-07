"""Manual "Backfill Tagging" job orchestrator (Experience → Topics page).

Loops ``lib.response_tagging.tag_untagged_responses`` in chunks until a
survey's untagged-response backlog is cleared, reporting progress into the
SAME ``agent_runs`` row every other job in this platform already knows how to
poll (``backend/src/routes/runs.ts``'s generic ``GET /api/runs/:runId``, via
``stream_events`` — same convention insight generation already uses, no new
progress-tracking mechanism invented). Node inserts the ``agent_runs`` row
(``run_type='topic_backfill'``) and calls ``POST /topics/backfill``
(``main.py``); this module only ever UPDATEs that row — it never INSERTs
one, mirroring the exact division of responsibility the insight-generation
pipeline already uses (Node owns the row, CrystalOS reports into it).

Why this exists: ``tag_untagged_responses`` is deliberately capped per call
(``RESPONSE_TAGGING_SWEEP_CAP``) and only fires automatically on new-response
events or a 15-minute scheduler tick — neither gives a user with a large
pre-existing backlog (an old survey, or one that hit the 2026-07-13 livelock
bug before it was fixed) any visible, on-demand way to say "catch this up
now." This orchestrator just calls that same, now-hardened function
repeatedly until there's nothing left to do, with progress the frontend can
show a bar for and the user can safely navigate away from — it's a server-
side background task, not tied to any open connection.

Deliberately duplicates ``_emit_event``/``_update_heartbeat``-shaped helpers
rather than importing ``graphs/insights.py``'s private versions of the same
pattern — same rationale as ``lib/response_tagging.py``'s own module
docstring: this stays a standalone, lightweight unit that doesn't pull in the
full LangGraph pipeline module for two one-line SQL UPDATEs.

Also the ONLY caller that passes ``include_retriable=True`` to
``tag_untagged_responses`` (added 2026-07-14) — a manual click here is the one
deliberate point where re-attempting a previously-QUARANTINED response (one
that repeatedly failed automatic tagging, still missing sentiment/emotion/
effort) is safe; the automatic stream/scheduler sweep must never do this
itself, or it defeats the point of quarantine.
"""
from __future__ import annotations

import asyncio
import json
import time

from crystalos.lib import db
from crystalos.lib import topic_registry
from crystalos.lib.logger import logger
from crystalos.lib.constants import RESPONSE_TAGGING_SWEEP_CAP, MAX_RESPONSE_TAGGING_ATTEMPTS
from crystalos.lib.response_tagging import tag_untagged_responses

# Small pause between chunks — same rationale as scheduler.py's backlog sweep
# (asyncio.sleep(1) between surveys): keeps one big backfill job from
# monopolizing the embedding/LLM concurrency budget shared with live traffic.
_CHUNK_PAUSE_SEC = 1.0

# Safety valve: if the untagged count hasn't decreased for this many
# consecutive chunks, stop instead of looping forever. Set one higher than
# MAX_RESPONSE_TAGGING_ATTEMPTS so tag_untagged_responses's own quarantine
# circuit breaker (lib/response_tagging.py::_record_batch_failure) gets a
# full chance to kick in and actually shrink the backlog before this outer
# valve gives up — this is a second, independent stop condition for a
# background loop, not a substitute for that one.
_MAX_NO_PROGRESS_CHUNKS = MAX_RESPONSE_TAGGING_ATTEMPTS + 1


async def _emit_event(run_id: str, event_type: str, data: dict) -> None:
    try:
        event = {
            "event": event_type,
            "agent": "topic_backfill",
            "data": data,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        async with db._pool_conn().connection() as conn:
            await conn.execute(
                "UPDATE agent_runs SET stream_events = stream_events || %s::jsonb WHERE id = %s",
                (json.dumps([event]), run_id),
            )
    except Exception as exc:
        logger.warning("topic_backfill_emit_event_failed", run_id=run_id, error=str(exc))


async def _update_heartbeat(run_id: str) -> None:
    try:
        async with db._pool_conn().connection() as conn:
            await conn.execute(
                "UPDATE agent_runs SET last_heartbeat_at = NOW() WHERE id = %s",
                (run_id,),
            )
    except Exception as exc:
        logger.debug("topic_backfill_heartbeat_failed", run_id=run_id, error=str(exc))


async def _get_run_status(run_id: str) -> str | None:
    """Cooperative cancellation between chunks — if the run has already been
    marked cancelled/failed out-of-band (a user action, or the zombie sweep),
    stop instead of doing more billed work nobody's waiting on."""
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute("SELECT status FROM agent_runs WHERE id = %s", (run_id,))
                row = await cur.fetchone()
                return row[0] if row else None
    except Exception as exc:
        logger.warning("topic_backfill_status_check_failed", run_id=run_id, error=str(exc))
        return None


async def _has_topics_yet(survey_id: str) -> bool:
    """Whether this survey has ANY existing topic centroid.

    Fixed 2026-07-13 (independent XM-customer/backend review): the lightweight
    sweep this job drives (``tag_untagged_responses``) can only ASSIGN to
    existing topics or discover incremental new ones once at least one topic
    already exists — a survey's very FIRST topic set only ever comes from the
    full insight pipeline's bootstrap run (whole-corpus clustering). For a
    survey that will never automatically reach that bootstrap (e.g. a
    closed/draft survey a customer just imported historical responses into —
    the stream/scheduler bootstrap triggers both require an active/paused
    survey), this job used to happily tag sentiment/emotion/effort, report
    "Backfill complete," and leave topics permanently empty with no signal
    anything was incomplete — a silent, misleading success. Checked once up
    front so ``run_topic_backfill`` can flag this honestly instead."""
    try:
        async with db._pool_conn().connection() as conn:
            return await topic_registry.has_centroids(survey_id, conn)
    except Exception as exc:
        logger.warning("topic_backfill_has_topics_check_failed", survey_id=survey_id, error=str(exc))
        return True  # fail open: don't block/mislabel a real run over a transient check failure


async def _count_untagged(survey_id: str, org_id: str, has_centroids: bool = False) -> int:
    """Counts both never-swept responses AND retriable ones — quarantined
    responses (``ai_enriched_at`` set, but sentiment/emotion/effort still NULL
    because every automatic attempt failed) and, when ``has_centroids`` is
    True, "topic orphans" (fully sentiment/emotion/effort-scored, only
    ``ai_topics`` missing — see ``lib/response_tagging.py::
    _fetch_untagged_responses``'s docstring) — since this job runs with
    ``include_retriable=True`` (added 2026-07-14, closing the gap where a
    manual Catch Up Tagging run could report "nothing to backfill" while
    quarantined/orphaned responses sat with permanently-missing data).
    Excludes ``ai_no_scorable_text`` responses — those are a terminal
    "nothing to score" state, not a retriable failure; counting them here
    would make this job re-charge for the exact same textless backlog on
    every click.

    ``has_centroids`` is a plain caller-supplied boolean (added 2026-07-14,
    self-review finding), not a fresh check here — ``run_topic_backfill``
    already computes it exactly once per run via ``_has_topics_yet`` for
    ``bootstrap_pending``, and this function is called on EVERY chunk inside
    that run's loop. An earlier version instead ran a correlated
    ``EXISTS (SELECT 1 FROM survey_topic_centroids …)`` subquery inline in
    the WHERE clause below — same unchanging answer, re-evaluated on every
    row of every chunk's COUNT(*) scan, for a survey's entire remaining
    backlog, every single chunk, for zero benefit over passing in the one
    value already known.

    Must stay in sync with backend/src/routes/insights.ts's own pre-check
    query for the SAME reason the 2026-07-13 bootstrap-gap bug existed:
    Node's short-circuit and this job's own count must never disagree about
    what "untagged" means, or one reports complete while the other still has
    work.
    """
    try:
        orphan_clause = " OR ai_topics IS NULL" if has_centroids else ""
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    f"""SELECT COUNT(*) FROM responses
                       WHERE survey_id = %s AND org_id = %s
                       AND (
                         ai_enriched_at IS NULL
                         OR (
                           ai_enriched_at IS NOT NULL AND ai_no_scorable_text = FALSE
                           AND (
                             ai_sentiment IS NULL OR ai_emotion IS NULL OR ai_effort_score IS NULL{orphan_clause}
                           )
                         )
                       )""",
                    (survey_id, org_id),
                )
                row = await cur.fetchone()
                return int(row[0]) if row else 0
    except Exception as exc:
        logger.warning("topic_backfill_count_failed", survey_id=survey_id, error=str(exc))
        return 0


async def _mark_run(run_id: str, status: str) -> None:
    try:
        async with db._pool_conn().connection() as conn:
            await conn.execute(
                "UPDATE agent_runs SET status=%s, completed_at=NOW() WHERE id=%s AND status='running'",
                (status, run_id),
            )
    except Exception as exc:
        logger.error("topic_backfill_mark_run_failed", run_id=run_id, error=str(exc))


async def _mark_uncategorized(survey_id: str, org_id: str) -> int:
    """Opens its own connection to call ``topic_registry.mark_candidates_
    uncategorized`` — see that function's docstring for the "Uncategorized"
    bucket's full rationale (added 2026-07-15). Never raises: this runs at
    the tail of an "evidence-collection stall" (this survey's remaining
    backlog genuinely can't be resolved by this job), and a failure to flag
    it for visibility must not turn an otherwise-correct 'completed' outcome
    into an unhandled exception — worst case, the flag just doesn't get set
    this time and the responses stay exactly as invisible as they already
    were, no worse off."""
    try:
        async with db._pool_conn().connection() as conn:
            count = await topic_registry.mark_candidates_uncategorized(survey_id, org_id, conn)
            await conn.commit()
            return count
    except Exception as exc:
        logger.warning("topic_backfill_mark_uncategorized_failed",
                        survey_id=survey_id, error=str(exc))
        return 0


async def run_topic_backfill(run_id: str, survey_id: str, org_id: str) -> None:
    """Drain a survey's entire untagged-response backlog, chunked at
    ``RESPONSE_TAGGING_SWEEP_CAP`` per call, reporting progress into
    ``agent_runs`` (row already created by the Node backend before this is
    called — see ``main.py::POST /topics/backfill``).

    Stops when: the backlog is empty (success — marks the row 'completed'),
    the run is cancelled/failed out-of-band (returns without touching the
    row further — whatever set that status already did), or
    ``_MAX_NO_PROGRESS_CHUNKS`` consecutive chunks do zero net work — marks
    'failed' UNLESS this run buffered at least one topic candidate along the
    way (see "Evidence-collection stall" below), should be very rare given
    ``tag_untagged_responses``'s own quarantine circuit breaker, but a
    long-running background loop needs its own independent stop condition
    too, so a future bug can never make this specific loop spin forever.

    Evidence-collection stall is NOT a failure (fixed 2026-07-14, customer-
    reported): a "topic orphan" batch that can't match any existing centroid
    gets buffered into ``topic_candidates`` instead (see
    ``lib/response_tagging.py::_process_batch``'s topic-assignment section).
    If those responses also never cluster tightly enough to cross
    ``min_cluster_size`` on a discovery flush, every future chunk re-fetches
    the SAME oldest orphans (``remaining`` never drops for them) and
    re-buffers them (a genuine ``ai_topics IS NULL``-until-more-evidence
    state, not a bug) — correctly zero ``chunk_activity`` every single time,
    which used to run out ``_MAX_NO_PROGRESS_CHUNKS`` and mark the WHOLE RUN
    'failed', an alarming and misleading status for something that isn't
    actually broken (these responses are legitimately waiting on either
    more similar live traffic or a future full-pipeline run, exactly the
    same as they'd wait under the automatic sweep with no backfill job
    running at all). ``buffered_total`` (mirrors ``quarantined_total``'s
    existing accumulation pattern) tracks whether ANY chunk in this run ever
    buffered a candidate; if so, the stall is reclassified 'completed' with
    a ``topics_pending_discovery`` count in the completion event instead of
    'failed' — the safety valve still fires 'failed' exactly as before for
    the case that actually matters (chunks producing literally zero effect
    of ANY kind — tagged, quarantined, assigned, discovered, OR buffered —
    which is the real bug signature this valve exists to catch).

    "Uncategorized" bucket (added 2026-07-15, customer-requested follow-up):
    on an evidence-collection stall, ``topic_registry.mark_candidates_
    uncategorized`` flags every still-buffered response's
    ``ai_topics_pending`` so it's visible (the Data page shows "Uncategorized"
    instead of a blank Topics cell) and filterable for manual review — the
    customer's own stated goal being able to look at that bucket later and
    spot a common thread the automated clustering missed. Deliberately does
    NOT touch ``ai_topics`` itself or remove anything from
    ``topic_candidates`` — the response stays exactly as eligible for a real,
    LLM-named topic on a future manual click or once enough similar live
    traffic accumulates as it always was; this is a purely additive
    visibility layer on top of the existing, unmodified discovery mechanism.

    Stall detection uses PER-CHUNK activity (``tagged + quarantined > 0`` this
    chunk — i.e. did the backlog actually shrink, deliberately excluding
    ``failed``, since a failed-but-not-yet-quarantined response is still
    untagged and will be retried later, not "progress"), not whether the live
    ``remaining`` count went down (fixed 2026-07-13, independent review
    finding) — on a survey that's still actively collecting responses, new
    arrivals can keep ``remaining`` flat or rising even while every chunk is
    successfully draining the backlog, which used to false-trip this valve
    into reporting a spurious failure.

    Honest completion (fixed 2026-07-13, independent review finding): quarantined
    responses (permanently skipped after repeated failures — see
    ``lib/response_tagging.py::_record_batch_failure``) are counted separately
    from ``processed`` and always surfaced in ``backfill_complete``. Reporting
    "complete" while silently omitting quarantined rows from the count would
    let a customer trust topic/NPS-driver analysis built on data that's
    missing real responses with no visible signal that anything was skipped.

    Bootstrap-gap disclosure (fixed 2026-07-13, independent customer/backend
    review finding — the single highest-severity gap found): this job can
    only ASSIGN to or incrementally discover topics once a survey already has
    at least one. A survey's first-ever topic set only ever comes from the
    full insight pipeline's bootstrap run, which the platform only triggers
    automatically for active/paused surveys. A closed or draft survey (e.g.
    one a customer just imported historical responses into) will therefore
    NEVER get topics through this job alone — it used to still tag sentiment/
    emotion/effort, report "Backfill complete," and leave topics permanently,
    silently empty. ``bootstrap_pending`` is now checked once up front and
    included in every emitted event so the frontend can say so honestly
    instead of implying topic tagging finished when it structurally couldn't
    have started.

    Never raises — this is started via ``asyncio.create_task`` with no
    awaiter, so an uncaught exception would otherwise only surface as an
    "unhandled task exception" log line, leaving the ``agent_runs`` row
    stuck 'running' until the zombie sweep reaps it up to 30 minutes later.
    Catching everything here gives the user an immediate, accurate result.
    """
    # Computed ONCE up front and threaded through every _count_untagged/
    # tag_untagged_responses call below (fixed 2026-07-14, self-review
    # finding) — this survey's centroids can't be created mid-run by
    # anything this loop does (the only path that could, discovery, is
    # itself gated on has_centroids already being True inside
    # _process_batch), so re-checking it per chunk — let alone per row via a
    # SQL subquery — would just repeat an already-settled answer.
    has_centroids = await _has_topics_yet(survey_id)
    bootstrap_pending = not has_centroids
    total_at_start = await _count_untagged(survey_id, org_id, has_centroids=has_centroids)
    await _emit_event(run_id, "backfill_started", {
        "total_untagged": total_at_start, "bootstrap_pending": bootstrap_pending,
    })

    if total_at_start == 0:
        await _mark_run(run_id, "completed")
        await _emit_event(run_id, "backfill_complete", {
            "total_untagged": 0, "processed": 0, "quarantined": 0, "bootstrap_pending": bootstrap_pending,
        })
        return

    processed = 0
    quarantined_total = 0
    buffered_total = 0
    no_progress_streak = 0
    try:
        while True:
            status = await _get_run_status(run_id)
            if status != "running":
                logger.info("topic_backfill_stopped_externally", run_id=run_id, status=status)
                return

            chunk_result = await tag_untagged_responses(
                survey_id, org_id, max_batch=RESPONSE_TAGGING_SWEEP_CAP,
                include_retriable=True, has_centroids=has_centroids,
            )
            await _update_heartbeat(run_id)

            processed          += chunk_result["tagged"]
            quarantined_total  += chunk_result.get("quarantined", 0)
            # Tracked (fixed 2026-07-14) but deliberately NOT part of
            # chunk_activity below — buffering the SAME still-unassignable
            # orphans every chunk (ai_topics stays NULL, so they're
            # re-fetched every time) is genuine ongoing work, but treating it
            # as "activity" would reset no_progress_streak forever and the
            # loop would never terminate. Used only at the stall decision
            # point further down, to tell "evidence-collection wait state"
            # apart from "truly nothing happened."
            buffered_total     += chunk_result.get("topics_buffered", 0)
            # Activity = backlog actually shrank this chunk (tagged OR
            # quarantined — both set ai_enriched_at). Deliberately excludes
            # `failed`: a failed-but-not-yet-quarantined response is still
            # untagged and will be retried by a future chunk, so it isn't
            # "progress" — counting it as such would mask a genuine stall
            # (e.g. _record_batch_failure itself broken) behind chunks that
            # look active but never actually free anything from the queue.
            #
            # Also includes topics_assigned/topics_discovered (added
            # 2026-07-14): a "topic orphan" (already sentiment/emotion/effort-
            # scored, only ai_topics missing — see _fetch_untagged_responses's
            # include_retriable docstring) never touches `tagged` at all, since
            # re-scoring it would be wasted cost. Its ONLY possible signal of
            # real progress (remaining, tracked via ai_topics IS NULL for this
            # case, actually shrinking) is topics_assigned/topics_discovered.
            # Without this, a chunk that successfully fixed nothing but a
            # batch of orphans' missing topics would look like zero activity
            # and could false-trip the stall valve on a perfectly healthy run.
            chunk_activity = (
                chunk_result["tagged"]
                + chunk_result.get("quarantined", 0)
                + chunk_result.get("topics_assigned", 0)
                + chunk_result.get("topics_discovered", 0)
            )
            remaining = await _count_untagged(survey_id, org_id, has_centroids=has_centroids)

            await _emit_event(run_id, "backfill_progress", {
                "total_untagged":    total_at_start,
                "processed":         processed,
                "quarantined":       quarantined_total,
                "remaining":         remaining,
                "topics_assigned":   chunk_result["topics_assigned"],
                "topics_discovered": chunk_result["topics_discovered"],
                "bootstrap_pending": bootstrap_pending,
            })

            if remaining == 0:
                await _mark_run(run_id, "completed")
                await _emit_event(run_id, "backfill_complete", {
                    "total_untagged": total_at_start, "processed": processed, "quarantined": quarantined_total,
                    "bootstrap_pending": bootstrap_pending,
                })
                return

            if chunk_activity == 0:
                no_progress_streak += 1
                if no_progress_streak >= _MAX_NO_PROGRESS_CHUNKS:
                    if buffered_total > 0:
                        # Evidence-collection wait state, not a bug (fixed
                        # 2026-07-14, customer-reported) — every remaining
                        # response is sitting in topic_candidates awaiting
                        # either more similar live traffic or a future full
                        # bootstrap run to actually cluster; this job cannot
                        # force that to happen sooner, and there is nothing
                        # further for it to safely retry. Marking 'completed'
                        # (with an honest count of what's still pending)
                        # instead of 'failed' — the underlying data is
                        # identically unresolved either way, but 'failed' is
                        # an alarming, incorrect signal for "waiting on more
                        # data," not "something is broken."
                        #
                        # Also flags these as ai_topics_pending ("Uncategorized",
                        # added 2026-07-15) so they're visible/filterable on the
                        # Data page instead of silently sitting in the
                        # topic_candidates buffer forever with no user-facing
                        # signal — see topic_registry.mark_candidates_
                        # uncategorized's docstring for why this is a SEPARATE
                        # flag rather than a synthetic ai_topics value, and why
                        # they stay in topic_candidates (still eligible for a
                        # real topic later).
                        uncategorized_count = await _mark_uncategorized(survey_id, org_id)
                        logger.info("topic_backfill_evidence_collection_stall",
                                     run_id=run_id, survey_id=survey_id, remaining=remaining,
                                     uncategorized_count=uncategorized_count)
                        await _mark_run(run_id, "completed")
                        await _emit_event(run_id, "backfill_complete", {
                            "total_untagged": total_at_start, "processed": processed,
                            "quarantined": quarantined_total, "bootstrap_pending": bootstrap_pending,
                            "topics_pending_discovery": uncategorized_count,
                        })
                        return
                    logger.error("topic_backfill_no_progress_stopping",
                                 run_id=run_id, survey_id=survey_id, remaining=remaining)
                    await _mark_run(run_id, "failed")
                    await _emit_event(run_id, "backfill_stalled", {
                        "total_untagged": total_at_start, "processed": processed,
                        "quarantined": quarantined_total, "remaining": remaining,
                    })
                    return
            else:
                no_progress_streak = 0

            await asyncio.sleep(_CHUNK_PAUSE_SEC)
    except Exception as exc:
        logger.error("topic_backfill_unexpected_error", run_id=run_id, survey_id=survey_id, error=str(exc))
        await _mark_run(run_id, "failed")
        await _emit_event(run_id, "backfill_failed", {"error": str(exc)})
