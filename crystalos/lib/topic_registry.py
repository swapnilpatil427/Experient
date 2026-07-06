"""Topic centroid registry — DB helpers for incremental pgvector-based clustering.

These functions manage the three tables introduced in 20240520000000_topic_centroids.sql:
  survey_topic_centroids — running-mean centroid per topic
  topic_candidates       — unassigned response buffer
  topic_windows          — weekly health snapshots per topic

All functions accept a live psycopg3 connection so the caller controls
transaction boundaries. None of these functions call the LLM.
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from typing import Any

import structlog

from crystalos.lib.constants import TOPIC_ASSIGNMENT_THRESHOLD

logger = structlog.get_logger()

# Cosine similarity threshold: new responses with sim >= this are assigned to
# the nearest existing topic. Responses below go into the candidate buffer.
# Re-exported from lib.constants (fixed 2026-07-04) — this used to be a second,
# independently-maintained literal that only matched constants.py's copy by
# coincidence; changing one silently stopped applying to nearest-centroid
# assignment. Keep the name ASSIGNMENT_THRESHOLD for backward compatibility
# (existing imports/call sites use it as assign_batch_to_nearest's default param).
ASSIGNMENT_THRESHOLD = TOPIC_ASSIGNMENT_THRESHOLD


# ── Vector helpers ────────────────────────────────────────────────────────────

def _parse_vector(v: Any) -> list[float] | None:
    """Parse a pgvector column value into a Python list of floats.

    psycopg3 returns vector columns as strings like '[0.1,0.2,...]' unless
    the pgvector psycopg adapter is registered.
    """
    if v is None:
        return None
    if isinstance(v, list):
        return [float(x) for x in v]
    if isinstance(v, str):
        try:
            return [float(x) for x in json.loads(v.replace("(", "[").replace(")", "]"))]
        except Exception:
            return None
    return None


def _format_vector(v: list[float]) -> str:
    """Format a Python list of floats as a pgvector literal string."""
    return "[" + ",".join(str(x) for x in v) + "]"


# ── Centroid registry ─────────────────────────────────────────────────────────

async def has_centroids(survey_id: str, conn) -> bool:
    """Return True if the survey already has topic centroids (i.e., not first run)."""
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT 1 FROM survey_topic_centroids WHERE survey_id = %s LIMIT 1",
                (survey_id,),
            )
            return await cur.fetchone() is not None
    except Exception as exc:
        logger.warning("topic_registry_has_centroids_failed", survey_id=survey_id, error=str(exc))
        return False


async def get_centroids(survey_id: str, conn) -> list[dict]:
    """Return all topic centroids for a survey as a list of dicts."""
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT id, topic_id, topic_name, centroid, response_count
                   FROM survey_topic_centroids
                   WHERE survey_id = %s
                   ORDER BY response_count DESC""",
                (survey_id,),
            )
            rows = await cur.fetchall()
            return [
                {
                    "id":             str(row[0]),
                    "topic_id":       str(row[1]) if row[1] else None,
                    "topic_name":     row[2],
                    "centroid":       _parse_vector(row[3]),
                    "response_count": row[4],
                }
                for row in rows
            ]
    except Exception as exc:
        logger.warning("topic_registry_get_centroids_failed", survey_id=survey_id, error=str(exc))
        return []


async def assign_batch_to_nearest(
    embeddings_by_rid: dict[str, list[float]],
    survey_id: str,
    conn,
    threshold: float = ASSIGNMENT_THRESHOLD,
) -> tuple[dict[str, str], list[str]]:
    """Assign a batch of response embeddings to the nearest topic centroid.

    Fetches all centroids once, then runs Python cosine similarity for each
    response (dot product works because OpenAI embeddings are L2-normalised).

    Returns:
        assignments:    {rid: topic_name} for responses above threshold
        unassigned_rids: rids that fell below threshold → go to candidate buffer

    Fault isolation (fixed 2026-07-13): a single malformed embedding (wrong
    dimension, non-numeric element, etc — far likelier to surface on an old
    survey's deep backlog than on fresh data) used to raise straight out of
    this function with no handling at all. Since callers run this inside a
    single all-or-nothing transaction alongside an already-committed-looking
    sentiment writeback, one bad row aborted the ENTIRE batch — and because
    the caller always re-selects the oldest-untagged rows first, the exact
    same poison row got re-fetched and re-failed forever, permanently
    starving every response behind it (including brand-new ones). Each row's
    similarity computation is now isolated: a bad row is logged and treated
    as unassigned (safe — it just falls into the candidate buffer / retry
    path) instead of taking the whole batch down with it.
    """
    if not embeddings_by_rid:
        return {}, []

    centroids = await get_centroids(survey_id, conn)
    if not centroids:
        return {}, list(embeddings_by_rid.keys())

    assignments: dict[str, str] = {}
    unassigned_rids: list[str] = []
    poisoned_count = 0

    for rid, embedding in embeddings_by_rid.items():
        best_topic: str | None = None
        best_sim = -1.0
        try:
            for c in centroids:
                c_vec = c["centroid"]
                if c_vec is None:
                    continue
                sim = sum(a * b for a, b in zip(embedding, c_vec))
                if sim > best_sim:
                    best_sim = sim
                    best_topic = c["topic_name"]
        except (TypeError, ValueError):
            poisoned_count += 1
            unassigned_rids.append(rid)
            continue

        if best_sim >= threshold and best_topic:
            assignments[rid] = best_topic
        else:
            unassigned_rids.append(rid)

    if poisoned_count:
        logger.warning(
            "topic_registry_assign_skipped_malformed_embeddings",
            survey_id=survey_id, count=poisoned_count,
        )

    return assignments, unassigned_rids


# ── Multi-topic-per-response support (added 2026-07-06) ────────────────────────
# assign_batch_to_nearest above is deliberately key-agnostic — it does pure
# per-key nearest-centroid math and doesn't care whether a key is a plain
# response_id or something else. That's what lets a caller assign PER OPEN-TEXT
# ANSWER instead of per-response (composite key: "{response_id}::{question_id}"),
# so a response with two open-text questions about two different things can
# genuinely match two different existing topics — previously every call site
# deduped to one embedding per response before calling assign_batch_to_nearest,
# so a response could only ever get one topic no matter how many open-text
# answers it had. These two helpers do the regrouping; no change to
# assign_batch_to_nearest's contract or callers that still pass plain
# response_id keys (there are none left after this fix, but the function
# itself doesn't require the composite-key convention).

def group_assignments_by_response(assignments: dict[str, str]) -> dict[str, list[str]]:
    """Regroup per-answer assignments (keyed "response_id::question_id") into
    per-response topic name lists — deduped, first-seen order preserved (a
    response with 3 answers all matching "Shipping Costs" gets that topic
    once, not three times).
    """
    by_response: dict[str, list[str]] = {}
    for key, topic_name in assignments.items():
        rid = key.split("::", 1)[0]
        names = by_response.setdefault(rid, [])
        if topic_name not in names:
            names.append(topic_name)
    return by_response


def dedupe_unassigned_to_one_per_response(
    unassigned_keys: list[str],
    embeddings_by_key: dict[str, list[float]],
) -> list[tuple[str, list[float]]]:
    """topic_candidates has UNIQUE(survey_id, response_id) — only one pending
    "unmatched, might seed a new topic" slot can exist per response. When a
    response has multiple unmatched answers, keep only the first encountered
    as that response's candidate. This does not lose the response's OTHER
    answers' topic assignments — those are handled entirely separately by
    group_assignments_by_response above; this only caps how many of a
    response's UNMATCHED answers get a shot at seeding a brand-new topic.
    """
    seen_rids: set[str] = set()
    result: list[tuple[str, list[float]]] = []
    for key in unassigned_keys:
        rid = key.split("::", 1)[0]
        if rid in seen_rids:
            continue
        seen_rids.add(rid)
        result.append((rid, embeddings_by_key[key]))
    return result


async def update_centroids_welford_batch(
    survey_id: str,
    topic_embeddings: dict[str, list[list[float]]],
    conn,
) -> None:
    """Update multiple topic centroids in a single locked SELECT + executemany UPDATE.

    topic_embeddings: {topic_name: [list of new embeddings to fold in]}

    Batch Welford formula:
        new_centroid = (old_centroid * old_count + sum(new_embeddings)) / (old_count + k)
    This is mathematically identical to running the online Welford formula k times.
    """
    if not topic_embeddings:
        return

    topic_names = list(topic_embeddings.keys())
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT topic_name, centroid, response_count
                   FROM survey_topic_centroids
                   WHERE survey_id = %s AND topic_name = ANY(%s)
                   FOR UPDATE""",
                (survey_id, topic_names),
            )
            rows = await cur.fetchall()

            updates: list[tuple] = []
            for row in rows:
                tname = row[0]
                old_vec = _parse_vector(row[1])
                old_count = int(row[2])
                new_embeddings = topic_embeddings.get(tname) or []
                if old_vec is None or not new_embeddings:
                    continue

                k = len(new_embeddings)
                new_count = old_count + k
                dim = len(old_vec)
                new_vec = [
                    (old_vec[i] * old_count + sum(emb[i] for emb in new_embeddings)) / new_count
                    for i in range(dim)
                ]
                updates.append((_format_vector(new_vec), new_count, survey_id, tname))

            if updates:
                await cur.executemany(
                    """UPDATE survey_topic_centroids
                       SET centroid = %s::vector, response_count = %s, updated_at = NOW()
                       WHERE survey_id = %s AND topic_name = %s""",
                    updates,
                )
    except Exception as exc:
        logger.warning(
            "topic_registry_welford_batch_failed",
            survey_id=survey_id, error=str(exc),
        )


async def add_candidates_batch(
    survey_id: str,
    org_id: str,
    rid_emb_pairs: list[tuple[str, list[float]]],
    conn,
) -> None:
    """Insert multiple candidate embeddings in a single executemany call."""
    if not rid_emb_pairs:
        return
    try:
        async with conn.cursor() as cur:
            await cur.executemany(
                """INSERT INTO topic_candidates (survey_id, org_id, response_id, embedding)
                   VALUES (%s, %s, %s, %s::vector)
                   ON CONFLICT (survey_id, response_id) DO NOTHING""",
                [(survey_id, org_id, rid, _format_vector(emb)) for rid, emb in rid_emb_pairs],
            )
    except Exception as exc:
        logger.warning(
            "topic_registry_add_candidates_batch_failed",
            survey_id=survey_id, error=str(exc),
        )


async def insert_centroid(
    survey_id: str,
    org_id: str,
    topic_name: str,
    centroid: list[float],
    response_count: int,
    conn,
    topic_id: str | None = None,
) -> None:
    """Insert a new centroid row. On conflict (same survey_id + topic_name),
    update the centroid and response_count — safe for concurrent bootstrap runs.
    """
    try:
        await conn.execute(
            """INSERT INTO survey_topic_centroids
                   (survey_id, org_id, topic_id, topic_name, centroid, response_count)
               VALUES (%s, %s, %s, %s, %s::vector, %s)
               ON CONFLICT (survey_id, topic_name) DO UPDATE SET
                   centroid = EXCLUDED.centroid,
                   response_count = EXCLUDED.response_count,
                   topic_id = COALESCE(EXCLUDED.topic_id, survey_topic_centroids.topic_id),
                   updated_at = NOW()""",
            (survey_id, org_id, topic_id, topic_name, _format_vector(centroid), response_count),
        )
    except Exception as exc:
        logger.warning(
            "topic_registry_insert_centroid_failed",
            survey_id=survey_id, topic_name=topic_name, error=str(exc),
        )


async def update_centroid_topic_id(
    survey_id: str,
    topic_name: str,
    topic_id: str,
    conn,
) -> None:
    """Link a centroid row to its survey_topics.id after LLM naming."""
    try:
        await conn.execute(
            """UPDATE survey_topic_centroids
               SET topic_id = %s, updated_at = NOW()
               WHERE survey_id = %s AND topic_name = %s""",
            (topic_id, survey_id, topic_name),
        )
    except Exception as exc:
        logger.warning(
            "topic_registry_update_topic_id_failed",
            survey_id=survey_id, topic_name=topic_name, error=str(exc),
        )


# ── Candidate buffer ──────────────────────────────────────────────────────────

async def get_candidate_count(survey_id: str, conn) -> int:
    """Return the number of unassigned candidates in the buffer for this survey."""
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT COUNT(*) FROM topic_candidates WHERE survey_id = %s",
                (survey_id,),
            )
            row = await cur.fetchone()
            return int(row[0]) if row else 0
    except Exception as exc:
        logger.warning("topic_registry_candidate_count_failed", survey_id=survey_id, error=str(exc))
        return 0


async def flush_candidates(survey_id: str, conn) -> list[dict]:
    """Return all candidate rows for this survey and delete them atomically.

    Returns list of {response_id, embedding} dicts.
    """
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                """DELETE FROM topic_candidates WHERE survey_id = %s
                   RETURNING response_id, embedding""",
                (survey_id,),
            )
            rows = await cur.fetchall()
            return [
                {"response_id": str(row[0]), "embedding": _parse_vector(row[1])}
                for row in rows
                if _parse_vector(row[1]) is not None
            ]
    except Exception as exc:
        logger.warning("topic_registry_flush_candidates_failed", survey_id=survey_id, error=str(exc))
        return []


# ── Topic health windows ──────────────────────────────────────────────────────

def _current_week_bounds() -> tuple[datetime, datetime]:
    """Return (Monday 00:00 UTC, Sunday 23:59:59 UTC) for the current ISO week."""
    now = datetime.now(timezone.utc)
    monday = now - timedelta(days=now.weekday())
    window_start = monday.replace(hour=0, minute=0, second=0, microsecond=0)
    window_end   = window_start + timedelta(days=7) - timedelta(seconds=1)
    return window_start, window_end


def _compute_health_label(
    current_count: int,
    current_sentiment: float | None,
    prior_count: int | None,
    prior_sentiment: float | None,
    is_first_window: bool,
) -> str:
    """Derive a health label from week-over-week deltas.

    emerging  — brand new topic (first window ever)
    growing   — response count up >25% vs prior week
    worsening — sentiment dropped >0.15 vs prior week (volume stable or up)
    fading    — response count down >30% vs prior week
    stable    — none of the above
    """
    if is_first_window:
        return "emerging"
    if prior_count is None or prior_count == 0:
        return "emerging"

    volume_change_pct = (current_count - prior_count) / max(1, prior_count) * 100
    if volume_change_pct > 25:
        return "growing"
    if volume_change_pct < -30:
        return "fading"

    if (
        current_sentiment is not None
        and prior_sentiment is not None
        and (current_sentiment - prior_sentiment) < -0.15
    ):
        return "worsening"

    return "stable"


async def upsert_survey_topic_signals(topic_id: str, signals: dict, conn) -> None:
    """Denormalise the full XM signal fingerprint onto survey_topics for fast API reads."""
    try:
        await conn.execute(
            """UPDATE survey_topics SET
               net_sentiment        = %s,
               nps_impact           = %s,
               promoter_pct         = %s,
               detractor_pct        = %s,
               passive_pct          = %s,
               urgency_score        = %s,
               driver_score         = %s,
               avg_csat             = %s,
               csat_impact          = %s,
               confidence_level     = %s,
               avg_effort_score     = %s,
               top_verbatims        = %s::jsonb,
               emotion_distribution = %s::jsonb,
               last_seen_at         = NOW()
             WHERE id = %s""",
            (
                signals.get("net_sentiment"),
                signals.get("nps_impact"),
                signals.get("promoter_pct"),
                signals.get("detractor_pct"),
                signals.get("passive_pct"),
                signals.get("urgency_score"),
                signals.get("driver_score"),
                signals.get("avg_csat"),
                signals.get("csat_impact"),
                signals.get("confidence_level", "medium"),
                signals.get("avg_effort_score"),
                json.dumps(signals.get("top_verbatims") or []),
                json.dumps(signals.get("emotion_distribution") or {}),
                topic_id,
            ),
        )
    except Exception as exc:
        logger.warning("topic_registry_upsert_signals_failed", topic_id=topic_id, error=str(exc))


async def _count_weekly_topic_responses(
    survey_id: str,
    topic_name: str,
    window_start: datetime,
    window_next_start: datetime,
    conn,
) -> int:
    """Count distinct responses submitted this ISO week that mention the topic.

    Uses the GIN-indexed responses.ai_topics JSONB array so this is O(log n).
    Called after node_topics commits ai_topics writeback, so data is always fresh.

    window_next_start is the EXCLUSIVE upper bound (next Monday 00:00:00 UTC),
    not the inclusive window_end (Sunday 23:59:59).  Using an exclusive bound
    of midnight avoids any microsecond boundary issues with Sunday submissions.
    """
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT COUNT(DISTINCT r.id)::int
                   FROM responses r
                   WHERE r.survey_id = %s
                     AND r.submitted_at >= %s
                     AND r.submitted_at < %s
                     AND r.ai_topics @> jsonb_build_array(%s::text)""",
                (survey_id, window_start, window_next_start, topic_name),
            )
            row = await cur.fetchone()
            return int(row[0]) if row and row[0] is not None else 0
    except Exception as exc:
        logger.warning(
            "topic_registry_weekly_count_failed",
            survey_id=survey_id, topic_name=topic_name, error=str(exc),
        )
        return 0


async def upsert_topic_window(
    survey_id: str,
    org_id: str,
    topic_id: str,
    signals: dict,
    conn,
    topic_name: str | None = None,
) -> str:
    """Upsert a topic_windows row for the current calendar week with full XM signals.

    Args:
        survey_id: Survey UUID.
        org_id: Organisation ID.
        topic_id: survey_topics.id for this topic.
        signals: Full XM signal dict from compute_full_topic_signals.
        conn: Active psycopg3 connection (caller controls transaction).
        topic_name: Canonical topic name used to query weekly response count from
                    responses.ai_topics.  When provided, velocity_pct is computed
                    from actual weekly submission counts (correct WoW delta) rather
                    than cumulative cluster size (which only grows — never fades).

    Returns:
        The computed health_label string.
    """
    avg_sentiment  = signals.get("avg_sentiment_score")
    avg_nps        = signals.get("avg_nps")

    window_start, window_end = _current_week_bounds()

    # Resolve weekly response count from the DB when topic_name is available.
    # Falls back to cluster size from signals when topic_name is not provided.
    if topic_name:
        weekly_count = await _count_weekly_topic_responses(
            survey_id, topic_name, window_start,
            window_start + timedelta(days=7),  # exclusive next Monday — captures full Sunday
            conn,
        )
    else:
        weekly_count = signals.get("response_count", 0)

    # Fetch the most recent prior window to compute health label
    prior_count: int | None = None
    prior_sentiment: float | None = None
    is_first_window = False
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT response_count, avg_sentiment_score
                   FROM topic_windows
                   WHERE topic_id = %s AND window_start < %s
                   ORDER BY window_start DESC
                   LIMIT 1""",
                (topic_id, window_start),
            )
            row = await cur.fetchone()
            if row is None:
                is_first_window = True
            else:
                prior_count     = row[0]
                prior_sentiment = float(row[1]) if row[1] is not None else None
    except Exception:
        is_first_window = True

    health_label = _compute_health_label(
        current_count=weekly_count,
        current_sentiment=avg_sentiment,
        prior_count=prior_count,
        prior_sentiment=prior_sentiment,
        is_first_window=is_first_window,
    )

    # velocity_pct: WoW change in weekly submissions for this topic
    velocity_pct: float | None = None
    if prior_count is not None:
        velocity_pct = round(
            (weekly_count - prior_count) / max(1, prior_count) * 100, 1
        )

    response_count = weekly_count

    try:
        await conn.execute(
            """INSERT INTO topic_windows
                   (survey_id, org_id, topic_id, window_start, window_end,
                    response_count, avg_sentiment_score, avg_nps, health_label,
                    net_sentiment, nps_impact, promoter_pct, detractor_pct, passive_pct,
                    urgency_score, driver_score, velocity_pct, avg_csat, csat_impact,
                    avg_effort_score, emotion_distribution, top_verbatims)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb)
               ON CONFLICT (topic_id, window_start) DO UPDATE SET
                   response_count       = EXCLUDED.response_count,
                   avg_sentiment_score  = EXCLUDED.avg_sentiment_score,
                   avg_nps              = EXCLUDED.avg_nps,
                   health_label         = EXCLUDED.health_label,
                   net_sentiment        = EXCLUDED.net_sentiment,
                   nps_impact           = EXCLUDED.nps_impact,
                   promoter_pct         = EXCLUDED.promoter_pct,
                   detractor_pct        = EXCLUDED.detractor_pct,
                   passive_pct          = EXCLUDED.passive_pct,
                   urgency_score        = EXCLUDED.urgency_score,
                   driver_score         = EXCLUDED.driver_score,
                   velocity_pct         = EXCLUDED.velocity_pct,
                   avg_csat             = EXCLUDED.avg_csat,
                   csat_impact          = EXCLUDED.csat_impact,
                   avg_effort_score     = EXCLUDED.avg_effort_score,
                   emotion_distribution = EXCLUDED.emotion_distribution,
                   top_verbatims        = EXCLUDED.top_verbatims""",
            (
                survey_id, org_id, topic_id, window_start, window_end,
                response_count, avg_sentiment, avg_nps, health_label,
                signals.get("net_sentiment"),
                signals.get("nps_impact"),
                signals.get("promoter_pct"),
                signals.get("detractor_pct"),
                signals.get("passive_pct"),
                signals.get("urgency_score"),
                signals.get("driver_score"),
                velocity_pct,
                signals.get("avg_csat"),
                signals.get("csat_impact"),
                signals.get("avg_effort_score"),
                json.dumps(signals.get("emotion_distribution") or {}),
                json.dumps(signals.get("top_verbatims") or []),
            ),
        )
        # Denormalise health_label and velocity_pct onto survey_topics for fast API reads
        await conn.execute(
            """UPDATE survey_topics SET health_label = %s, velocity_pct = %s WHERE id = %s""",
            (health_label, velocity_pct, topic_id),
        )
    except Exception as exc:
        logger.warning(
            "topic_registry_upsert_window_failed",
            topic_id=topic_id, survey_id=survey_id, error=str(exc),
        )

    return health_label
