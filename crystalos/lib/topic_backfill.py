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
"""
from __future__ import annotations

import asyncio
import json
import time

from crystalos.lib import db
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


async def _count_untagged(survey_id: str, org_id: str) -> int:
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT COUNT(*) FROM responses
                       WHERE survey_id = %s AND org_id = %s AND ai_enriched_at IS NULL""",
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


async def run_topic_backfill(run_id: str, survey_id: str, org_id: str) -> None:
    """Drain a survey's entire untagged-response backlog, chunked at
    ``RESPONSE_TAGGING_SWEEP_CAP`` per call, reporting progress into
    ``agent_runs`` (row already created by the Node backend before this is
    called — see ``main.py::POST /topics/backfill``).

    Stops when: the backlog is empty (success — marks the row 'completed'),
    the run is cancelled/failed out-of-band (returns without touching the
    row further — whatever set that status already did), or
    ``_MAX_NO_PROGRESS_CHUNKS`` consecutive chunks do zero net work (marks
    'failed' — should be very rare given ``tag_untagged_responses``'s own
    quarantine circuit breaker, but a long-running background loop needs its
    own independent stop condition too, so a future bug can never make this
    specific loop spin forever).

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

    Never raises — this is started via ``asyncio.create_task`` with no
    awaiter, so an uncaught exception would otherwise only surface as an
    "unhandled task exception" log line, leaving the ``agent_runs`` row
    stuck 'running' until the zombie sweep reaps it up to 30 minutes later.
    Catching everything here gives the user an immediate, accurate result.
    """
    total_at_start = await _count_untagged(survey_id, org_id)
    await _emit_event(run_id, "backfill_started", {"total_untagged": total_at_start})

    if total_at_start == 0:
        await _mark_run(run_id, "completed")
        await _emit_event(run_id, "backfill_complete", {"total_untagged": 0, "processed": 0, "quarantined": 0})
        return

    processed = 0
    quarantined_total = 0
    no_progress_streak = 0
    try:
        while True:
            status = await _get_run_status(run_id)
            if status != "running":
                logger.info("topic_backfill_stopped_externally", run_id=run_id, status=status)
                return

            chunk_result = await tag_untagged_responses(survey_id, org_id, max_batch=RESPONSE_TAGGING_SWEEP_CAP)
            await _update_heartbeat(run_id)

            processed          += chunk_result["tagged"]
            quarantined_total  += chunk_result.get("quarantined", 0)
            # Activity = backlog actually shrank this chunk (tagged OR
            # quarantined — both set ai_enriched_at). Deliberately excludes
            # `failed`: a failed-but-not-yet-quarantined response is still
            # untagged and will be retried by a future chunk, so it isn't
            # "progress" — counting it as such would mask a genuine stall
            # (e.g. _record_batch_failure itself broken) behind chunks that
            # look active but never actually free anything from the queue.
            chunk_activity = chunk_result["tagged"] + chunk_result.get("quarantined", 0)
            remaining = await _count_untagged(survey_id, org_id)

            await _emit_event(run_id, "backfill_progress", {
                "total_untagged":    total_at_start,
                "processed":         processed,
                "quarantined":       quarantined_total,
                "remaining":         remaining,
                "topics_assigned":   chunk_result["topics_assigned"],
                "topics_discovered": chunk_result["topics_discovered"],
            })

            if remaining == 0:
                await _mark_run(run_id, "completed")
                await _emit_event(run_id, "backfill_complete", {
                    "total_untagged": total_at_start, "processed": processed, "quarantined": quarantined_total,
                })
                return

            if chunk_activity == 0:
                no_progress_streak += 1
                if no_progress_streak >= _MAX_NO_PROGRESS_CHUNKS:
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
