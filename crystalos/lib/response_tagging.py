"""Lightweight per-response sentiment/emotion/effort/topic tagging sweep.

Added 2026-07-04 alongside ``insight_settings.py::resolve_response_tagging_batch_size``.
Decouples "when do individual responses get scored" from "when does a full
report+checkpoint get generated" (``graphs/insights.py``'s 17-node pipeline, still
gated by ``stream_response_threshold`` — unchanged, default 100). This module is
intentionally NOT part of that pipeline and does not import from ``graphs/insights.py``
— it is invoked directly, in-process, from ``consumers/response_stream.py`` (on a
cadence governed by ``response_tagging_batch_size``, default 1 — tag every response
as it arrives) and from ``scheduler.py`` (a periodic backlog sweep for surveys not
currently receiving live traffic).

Reuses the SAME lower-level primitives as ``node_absa``/``node_topics``
(``tools/sentiment.py::run_absa_llm``, ``tools/metrics.py::compute_effort_score``,
``lib/topic_registry.py::assign_batch_to_nearest``) so this sweep and a later full
pipeline run never disagree about how a response is scored — and ``node_absa``/
``node_topics`` already skip re-scoring anything with ``ai_enriched_at`` set
(``graphs/insights.py:1787``), so responses tagged here are simply cache hits by
the time a full run happens, never double-charged.

Deliberately has NO ``len(texts) < 3`` floor (unlike ``node_absa`` — that floor
exists to avoid a wasteful LLM call for a trivially small *report* corpus).
``response_tagging_batch_size`` defaults to 1, i.e. "score this response right
now" — a hard floor would silently break that default.

New-topic discovery: unassigned responses buffer into the same ``topic_candidates``
table ``node_cluster`` reads from. Once the buffer crosses
``topic_discovery_candidate_threshold`` (resolved per survey/org/platform via
``insight_settings.resolve_topic_discovery_candidate_threshold`` — shared with
``node_cluster`` so both "is there enough evidence for a new topic" checks agree),
THIS module also flushes and discovers the new topic itself (cluster by embedding
similarity, LLM-name the cluster, insert the centroid, tag matching responses) —
it does not wait for the next full report run. Only runs for a survey that already
has at least one existing topic (``topic_registry.has_centroids``); a survey's
very first-ever topic set still only comes from the full pipeline's bootstrap run,
which looks at the whole corpus at once — that is not something a per-response
sweep can meaningfully replicate.

Discovery clustering uses ``TOPIC_DISCOVERY_SIMILARITY_THRESHOLD`` (0.80, stricter
than ``TOPIC_ASSIGNMENT_THRESHOLD``'s 0.72) and a resolved
``topic_discovery_min_cluster_size`` (platform default 5, not 2) — a brand-new,
permanently-stored, LLM-named topic is a costlier mistake than a nudge to an
already-vetted centroid, so discovery is deliberately more conservative than
assignment (added 2026-07-06).

Two terminal-vs-retriable states share the same ``ai_enriched_at IS NOT NULL``
surface but must never be confused (added 2026-07-14): a response with no
scorable open-text answer (``ai_no_scorable_text``, set by
``_mark_enriched_no_text``) is DONE — there is nothing to tag and it must never
be reselected. A quarantined response (``ai_tagging_attempts`` maxed out,
``ai_no_scorable_text`` still False, sentiment/emotion/effort still NULL)
FAILED rather than having nothing to score, and is retriable — but only via a
deliberate, user-initiated manual Catch Up Tagging run (``include_retriable``),
never by the automatic stream/scheduler sweep, which must keep leaving it alone
or it defeats the point of quarantine.

A THIRD, distinct retriable state (also 2026-07-14): a "topic orphan" —
sentiment/emotion/effort all present, only ``ai_topics`` is NULL. This is not
a failure at all; it happens whenever a response was swept before this
survey's topic centroids existed, or its embedding fell below
``min_cluster_size`` on a prior discovery flush (``graphs/insights.py`` calls
the identical case a "bootstrap orphan" in its own full-pipeline run).
``include_retriable`` reselects these too, but ``_process_batch`` skips ABSA
for them entirely — only topic assignment runs, since re-scoring would
re-charge for an answer that's already correct.
"""
from __future__ import annotations

import asyncio
import json
from collections import defaultdict

from crystalos.lib import db
from crystalos.lib import topic_registry
from crystalos.lib.logger import logger
from crystalos.lib.constants import (
    RESPONSE_TAGGING_SWEEP_CAP, TOPIC_DISCOVERY_SIMILARITY_THRESHOLD, MAX_RESPONSE_TAGGING_ATTEMPTS,
)
from crystalos.lib.insight_settings import (
    resolve_topic_discovery_candidate_threshold, resolve_topic_discovery_min_cluster_size,
)
from crystalos.lib.models import ModelConfig, get_model, get_absa_config
from crystalos.tools.clustering import cluster_texts
from crystalos.tools.embeddings import get_or_create_embeddings
from crystalos.tools.metrics import extract_open_texts, compute_effort_score
from crystalos.tools.sentiment import run_absa_llm
from crystalos.tools.topics import discover_topics

_TAGGING_TEMPERATURE = 0.0


async def _llm_raw(prompt: str, max_tokens: int = 2500) -> str:
    """Same shape as ``graphs/insights.py::_llm_raw``, duplicated intentionally so
    this module stays a standalone, lightweight unit callable from the streaming
    consumer and scheduler without importing the full LangGraph pipeline module."""
    from crystalos.lib.openrouter import _retry_loop

    base = get_model("insight_narrate")
    config = ModelConfig(
        model=base.model,
        max_tokens=max_tokens,
        temperature=_TAGGING_TEMPERATURE,
        use_anthropic_sdk=base.use_anthropic_sdk,
    )
    content, _usage = await _retry_loop([{"role": "user", "content": prompt}], config, json_mode=False)
    return content


async def _fetch_untagged_responses(
    survey_id: str, org_id: str, limit: int, conn,
    include_retriable: bool = False, has_centroids: bool = False,
) -> list[dict]:
    """Untagged = ``ai_enriched_at IS NULL``. Oldest first, so a persistent backlog
    (or a response whose scoring previously failed) surfaces before brand-new ones.
    This is also how "tag any previously missing ones, especially if they failed
    before" is satisfied with no separate failure-tracking state: a failed attempt
    simply never sets ``ai_enriched_at``, so it's naturally retried on the next
    sweep — no dead-letter table or retry counter needed.

    ``include_retriable`` (added 2026-07-14, manual Catch Up Tagging only):
    ALSO reselects responses that already went through this sweep
    (``ai_enriched_at`` IS NOT NULL) but are still missing ``ai_sentiment``,
    ``ai_emotion``, or ``ai_effort_score`` — i.e. a response quarantined by
    ``_record_batch_failure`` after repeatedly failing. Explicitly EXCLUDES
    anything ``_mark_enriched_no_text`` has confirmed has no scorable text
    (``ai_no_scorable_text``) — that is a terminal state, not a failure, and
    must never be reselected, or every survey with any skipped open-text
    answers would re-pay this query's cost forever. The regular sweep
    (stream consumer / 15-min scheduler) always leaves this False —
    automatically retrying a quarantined response forever is exactly what
    quarantine exists to prevent; a deliberate, user-initiated manual
    backfill click is the only sane point to give it another attempt.

    Also reselects "topic orphans" (added 2026-07-14): fully sentiment/
    emotion/effort-scored responses whose ``ai_topics`` is still NULL — this
    happens whenever a response was swept by this module BEFORE the survey's
    topic centroids existed (``graphs/insights.py``'s full pipeline calls
    these the same thing — see its own ``ai_enriched_at and not ai_topics``
    bootstrap-orphan check), or whose cluster fell below
    ``min_cluster_size`` on a prior run. Gated on the CALLER-supplied
    ``has_centroids`` — while centroids don't exist yet, topic assignment
    structurally cannot happen (see the module docstring's terminal-vs-
    retriable note and ``lib/topic_backfill.py::_has_topics_yet``), so
    reselecting these orphans before that would just be wasted cost on every
    manual click with no possible outcome; the existing ``bootstrap_pending``
    disclosure already tells the user to fix that first via Generate Report.
    Deliberately a plain boolean, not an ``EXISTS (SELECT 1 FROM
    survey_topic_centroids …)`` subquery inline in this WHERE clause (fixed
    2026-07-14, self-review finding) — every caller in this module's call
    chain already computes "does this survey have centroids yet" exactly
    once per run via ``topic_registry.has_centroids``/``_has_topics_yet``
    (see ``lib/topic_backfill.py::run_topic_backfill``'s ``bootstrap_pending``
    and ``backend/src/routes/insights.ts``'s own single check) — a correlated
    subquery here would re-evaluate the identical, unchanging answer on every
    row scanned by this query instead of reusing that one already-known
    value, for zero benefit.

    ``FOR UPDATE SKIP LOCKED`` (added 2026-07-13, independent review finding):
    the live stream consumer, the 15-min scheduler backlog sweep, and the manual
    backfill job can all call this for the SAME survey concurrently. Without row
    locking they'd all fetch the identical oldest batch and pay for embeddings +
    ABSA LLM calls on the same responses twice (or more) — a direct cost/accuracy
    regression. Locking here means a concurrent caller transparently skips
    whatever another in-flight call already claimed and gets the next available
    untagged rows instead; the lock is released at this transaction's next
    commit/rollback (see ``_process_batch``'s early sentiment commit), by which
    point those rows already have ``ai_enriched_at`` set and naturally drop out
    of any concurrent caller's WHERE clause anyway."""
    retriable_clause = ""
    if include_retriable:
        orphan_clause = " OR ai_topics IS NULL" if has_centroids else ""
        retriable_clause = f"""
                 OR (
                   ai_enriched_at IS NOT NULL AND ai_no_scorable_text = FALSE
                   AND (
                     ai_sentiment IS NULL OR ai_emotion IS NULL OR ai_effort_score IS NULL{orphan_clause}
                   )
                 )"""
    async with conn.cursor() as cur:
        await cur.execute(
            f"""SELECT id, answers, ai_sentiment, ai_emotion, ai_effort_score
               FROM responses
               WHERE survey_id = %s AND org_id = %s
               AND (
                 ai_enriched_at IS NULL{retriable_clause}
               )
               ORDER BY submitted_at ASC
               LIMIT %s
               FOR UPDATE SKIP LOCKED""",
            (survey_id, org_id, limit),
        )
        rows = await cur.fetchall()
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in rows]


async def _mark_enriched_no_text(response_ids: list[str], conn) -> None:
    """Nothing for ABSA/topics to score for these responses — either the survey
    has zero open-text questions, or (mixed batch) these specific responses
    skipped/left blank the open-text question their batch-mates answered. Mark
    them enriched with ``ai_no_scorable_text`` so they stop being re-selected by
    every future sweep forever — including the manual Catch Up Tagging job's
    ``include_retriable`` mode, which otherwise would treat their permanently-
    NULL sentiment/emotion/effort as a retriable failure and re-pay this query's
    cost on every future backfill click."""
    if not response_ids:
        return
    async with conn.cursor() as cur:
        await cur.executemany(
            "UPDATE responses SET ai_enriched_at=NOW(), ai_no_scorable_text=TRUE WHERE id=%s",
            [(rid,) for rid in response_ids],
        )


async def _reconstruct_absa_items(
    response_ids: list[str], questions: list[dict], conn,
) -> dict[str, dict]:
    """Rebuild ABSA-shaped items ({response_id, question_id, text, aspect,
    sentiment, score, emotion}) for candidates buffered in a PRIOR sweep call,
    whose in-memory ABSA result is long gone. Reads back this sweep module's own
    prior writeback (ai_sentiment/ai_sentiment_score/ai_emotion) — every candidate
    reaching this point was necessarily scored by this same function before being
    buffered, so these columns are always already set. ``aspect`` has no stored
    equivalent once a sweep call ends, so it defaults to "general" — same fallback
    ``tools/sentiment.py::_heuristic_item`` uses when ABSA itself has no aspect."""
    if not response_ids:
        return {}
    async with conn.cursor() as cur:
        await cur.execute(
            """SELECT id, answers, ai_sentiment, ai_sentiment_score, ai_emotion
               FROM responses WHERE id = ANY(%s)""",
            (response_ids,),
        )
        rows = await cur.fetchall()
        cols = [d[0] for d in cur.description]
        resp_rows = [dict(zip(cols, r)) for r in rows]

    texts_by_rid: dict[str, str] = {}
    for t in extract_open_texts(resp_rows, questions):
        texts_by_rid.setdefault(str(t["response_id"]), t["text"])

    reconstructed: dict[str, dict] = {}
    for r in resp_rows:
        rid = str(r["id"])
        text = texts_by_rid.get(rid)
        if not text:
            continue
        reconstructed[rid] = {
            "response_id": rid, "question_id": "", "text": text, "aspect": "general",
            "sentiment": r.get("ai_sentiment") or "neutral",
            "score": float(r.get("ai_sentiment_score") or 0.0),
            "emotion": r.get("ai_emotion") or "neutral",
        }
    return reconstructed


def _cluster_summary_for_discovery(idx: int, items: list[dict]) -> dict:
    """Minimal cluster dict shaped for tools/topics.py::discover_topics — NOT the
    full graphs/insights.py::_make_cluster_from_items (deliberately duplicated
    rather than imported, to keep this module independent of the full pipeline)."""
    avg_score = sum(i.get("score", 0.0) for i in items) / len(items)
    neg = sum(1 for i in items if i.get("sentiment") == "negative")
    pos = sum(1 for i in items if i.get("sentiment") == "positive")
    dom_sentiment = "negative" if neg > pos else ("positive" if pos > neg else "neutral")
    emotion_counts: dict[str, int] = {}
    for i in items:
        e = i.get("emotion", "neutral")
        emotion_counts[e] = emotion_counts.get(e, 0) + 1
    dom_emotion = max(emotion_counts, key=emotion_counts.get) if emotion_counts else "neutral"
    return {
        "id": f"tagging_cluster_{idx}",
        "aspect": "general",
        "texts": items,
        "size": len(items),
        "avg_sentiment_score": round(avg_score, 2),
        "dominant_sentiment": dom_sentiment,
        "dominant_emotion": dom_emotion,
    }


async def _flush_and_discover_topics(
    survey_id: str,
    org_id: str,
    conn,
    questions: list[dict],
    by_resp: dict[str, list[dict]],
    min_cluster_size: int,
) -> int:
    """Flush the topic_candidates buffer, cluster by embedding similarity (no
    LLM), LLM-name each resulting cluster, insert new centroids, and tag matching
    responses' ai_topics. Returns the number of new topics discovered.

    Any candidate that doesn't end up in a cluster of >= min_cluster_size is
    re-buffered (not lost) — it simply didn't have enough close-enough peers
    THIS time; it stays eligible for a future flush once more matching responses
    arrive. This mirrors node_cluster's guarantee that no response is silently
    dropped, just without that node's aspect-based fallback grouping (which needs
    a same-run ABSA aspect this module doesn't retain across sweep calls — see
    _reconstruct_absa_items).

    Uses TOPIC_DISCOVERY_SIMILARITY_THRESHOLD (stricter than the 0.72 used for
    nearest-centroid assignment) and the resolved min_cluster_size (platform
    default 5, not cluster_texts's own default of 2) — added 2026-07-06, since a
    brand-new permanent topic is a costlier mistake than a nudge to an existing
    centroid.
    """
    from crystalos.lib.openrouter import call_agent

    candidates = await topic_registry.flush_candidates(survey_id, conn)
    if not candidates:
        return 0

    emb_by_rid = {c["response_id"]: c["embedding"] for c in candidates}
    cand_rids = list(emb_by_rid.keys())

    just_scored = {rid: items[0] for rid, items in by_resp.items() if rid in emb_by_rid}
    missing_rids = [rid for rid in cand_rids if rid not in just_scored]
    reconstructed = await _reconstruct_absa_items(missing_rids, questions, conn) if missing_rids else {}

    cand_texts = []
    for rid in cand_rids:
        item = just_scored.get(rid) or reconstructed.get(rid)
        if item:
            cand_texts.append({**item, "embedding": emb_by_rid[rid]})

    if not cand_texts:
        return 0

    raw_clusters = cluster_texts(
        cand_texts, threshold=TOPIC_DISCOVERY_SIMILARITY_THRESHOLD, min_cluster_size=min_cluster_size,
    )
    clustered_rids = {str(item["response_id"]) for raw in raw_clusters for item in raw["texts"]}
    leftover_rids = [rid for rid in cand_rids if rid not in clustered_rids]
    if leftover_rids:
        await topic_registry.add_candidates_batch(
            survey_id, org_id, [(rid, emb_by_rid[rid]) for rid in leftover_rids], conn,
        )

    if not raw_clusters:
        return 0

    clusters_for_llm = [_cluster_summary_for_discovery(i, raw["texts"]) for i, raw in enumerate(raw_clusters)]
    existing_names = [c["topic_name"] for c in await topic_registry.get_centroids(survey_id, conn)]

    try:
        new_topics = await discover_topics(clusters_for_llm, existing_names, call_agent)
    except Exception:
        # Don't lose the evidence — re-buffer everything that was about to be
        # clustered so the next flush (with a bigger, hopefully more LLM-friendly
        # buffer) tries again.
        await topic_registry.add_candidates_batch(
            survey_id, org_id, [(rid, emb_by_rid[rid]) for rid in cand_rids], conn,
        )
        raise

    topic_updates: list[tuple[str, str]] = []
    for cluster, topic_item in zip(clusters_for_llm, new_topics):
        cluster_embs = [t["embedding"] for t in cluster["texts"] if t.get("embedding")]
        if not cluster_embs:
            continue
        dim = len(cluster_embs[0])
        centroid_vec = [sum(e[i] for e in cluster_embs) / len(cluster_embs) for i in range(dim)]
        await topic_registry.insert_centroid(
            survey_id, org_id, topic_item.name, centroid_vec, len(cluster["texts"]), conn,
        )
        for item in cluster["texts"]:
            topic_updates.append((json.dumps([topic_item.name]), item["response_id"]))

    if topic_updates:
        async with conn.cursor() as cur:
            # ai_topics_pending=FALSE (added 2026-07-15): a response
            # previously flagged "Uncategorized" (topic_registry.mark_
            # candidates_uncategorized) that a LATER discovery flush
            # successfully clusters into a real, LLM-named topic must stop
            # showing as pending — the real topic name now takes over. Safe
            # to unconditionally clear even for responses that were never
            # flagged (already FALSE, a no-op).
            await cur.executemany(
                "UPDATE responses SET ai_topics=%s, ai_topics_pending=FALSE WHERE id=%s",
                topic_updates,
            )

    return len(new_topics)


async def _record_batch_failure(response_ids: list[str], error_msg: str) -> list[str]:
    """Circuit breaker (added 2026-07-13): bump ``ai_tagging_attempts`` for a batch
    that failed to process, and quarantine (set ``ai_enriched_at=NOW()``) any
    response that has now failed ``MAX_RESPONSE_TAGGING_ATTEMPTS`` times in a row.

    Without this, ANY bug anywhere in this function's pipeline (ABSA LLM call,
    embedding, DB writeback — this is deliberately not scoped to one known cause)
    that reliably throws for a specific response would cause ``_fetch_untagged_
    responses``'s ``ORDER BY submitted_at ASC LIMIT`` to re-select and re-fail on
    the exact same oldest rows on every future sweep call, forever — permanently
    starving every response behind them, including brand-new ones (this is the
    literal production incident that motivated this fix). Quarantining a
    genuinely-poisoned response after a bounded number of attempts guarantees the
    queue always makes forward progress regardless of what causes a given attempt
    to fail. Runs in its OWN fresh connection since the connection tied to the
    failed sweep may itself be left in an aborted transaction state.

    Returns the list of response_ids NEWLY quarantined by this call (for
    tests, and for the caller's own progress/stall accounting — see below).

    The ``WHERE`` guard matches never-touched responses (``ai_enriched_at IS
    NULL``) AND already-quarantined ones being retried by the manual Catch Up
    Tagging job's ``include_retriable`` mode that failed AGAIN (added
    2026-07-14) — without the second branch, a response manually retried after
    being quarantined would silently no-op here on a repeat failure: its
    ``ai_tagging_attempts``/``ai_tagging_last_error`` would go stale (ops loses
    visibility that a retry was even attempted) since ``ai_enriched_at`` is
    already set from the ORIGINAL quarantine. Still excludes
    ``ai_no_scorable_text`` — a confirmed-no-text response never reaches this
    function (nothing there can raise), so it must never match either branch.

    The returned list deliberately EXCLUDES a response that was ALREADY
    quarantined before this call (``ai_enriched_at`` already set) even though
    its attempts/error just got bumped — added 2026-07-14, closing a livelock
    this exact fix would otherwise reopen: ``lib/topic_backfill.py``'s stall
    detection treats a non-empty ``quarantined`` count as "this chunk made
    real progress" (deliberately, since quarantining IS supposed to be a
    one-time, backlog-shrinking event). If a repeat failure of an
    already-quarantined response counted again every time it's retried,
    run_topic_backfill's ``while True`` loop would see non-zero "progress"
    on every single chunk forever for a survey whose entire remaining backlog
    is permanently-broken retriable responses — its stall safety valve would
    never trip, the run would never terminate on its own, and the same
    handful of responses would be double/triple/quadruple-counted into the
    user-facing "N responses were quarantined" total across chunks. Only a
    response crossing the quarantine threshold for the FIRST time genuinely
    shrinks the backlog and belongs in this list.
    """
    if not response_ids:
        return []
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """UPDATE responses
                       SET ai_tagging_attempts = ai_tagging_attempts + 1,
                           ai_tagging_last_error = %s
                       WHERE id = ANY(%s)
                       AND (
                         ai_enriched_at IS NULL
                         OR (
                           ai_enriched_at IS NOT NULL AND ai_no_scorable_text = FALSE
                           AND (ai_sentiment IS NULL OR ai_emotion IS NULL OR ai_effort_score IS NULL)
                         )
                       )
                       RETURNING id, ai_tagging_attempts, ai_enriched_at IS NOT NULL AS already_enriched""",
                    (error_msg[:500], response_ids),
                )
                rows = await cur.fetchall()
                # ai_enriched_at is untouched by the SET clause above, so
                # `already_enriched` reflects this row's state BEFORE this
                # call — True only for a retried, already-quarantined response.
                quarantine_ids = [
                    str(r[0]) for r in rows
                    if r[1] >= MAX_RESPONSE_TAGGING_ATTEMPTS and not r[2]
                ]
                if quarantine_ids:
                    await cur.executemany(
                        "UPDATE responses SET ai_enriched_at = NOW() WHERE id = %s",
                        [(rid,) for rid in quarantine_ids],
                    )
            await conn.commit()
        if quarantine_ids:
            logger.error(
                "response_tagging_quarantined_after_max_attempts",
                count=len(quarantine_ids), response_ids=quarantine_ids,
            )
        return quarantine_ids
    except Exception as exc:
        logger.error("response_tagging_record_failure_failed", error=str(exc))
        return []


def _merge_partial_result(result: dict, partial: dict) -> None:
    """Accumulate a ``_process_batch`` partial result into the running total —
    used both for the single whole-batch call and for the per-row fallback
    (which calls ``_process_batch`` once per response and needs to sum them)."""
    result["tagged"]            += partial.get("tagged", 0)
    result["topics_assigned"]   += partial.get("topics_assigned", 0)
    result["topics_buffered"]   += partial.get("topics_buffered", 0)
    result["topics_discovered"] += partial.get("topics_discovered", 0)


async def _process_batch(
    survey_id: str,
    org_id: str,
    responses: list[dict],
    questions: list[dict],
    conn,
    candidate_threshold: int,
    min_cluster_size: int,
) -> dict:
    """Score sentiment/emotion/effort and assign/discover topics for exactly the
    given list of responses, on the given connection.

    Skips ABSA/sentiment re-scoring for any response already fully scored
    (``ai_sentiment``/``ai_emotion``/``ai_effort_score`` all present — a "topic
    orphan," only reachable via ``include_retriable``, added 2026-07-14) —
    only topic assignment runs for these; see the module docstring's
    terminal-vs-retriable note.

    RAISES on any failure that should trigger the caller's per-row isolation
    fallback (``extract_open_texts``, the aggregation loop, or the sentiment
    writeback) — added 2026-07-13, independent review finding. The topic-
    assignment section below keeps its OWN internal try/except (unchanged):
    it's already fully isolated (``assign_batch_to_nearest`` can't crash the
    batch; every ``topic_registry`` write self-protects), so a topic-only
    failure doesn't need to fall all the way back to per-row retry — it would
    gain nothing (nothing there is response-data-dependent in the way that,
    say, a malformed ``answers`` field is) and would only add cost.

    Never sets ``ai_enriched_at`` on a response without also committing its
    sentiment score in the same statement — a caller retrying a subset of a
    failed batch therefore can't produce a half-written response.

    Returns a partial result dict: ``{tagged, topics_assigned,
    topics_buffered, topics_discovered}``.
    """
    result = {"tagged": 0, "topics_assigned": 0, "topics_buffered": 0, "topics_discovered": 0}

    texts = extract_open_texts(responses, questions)

    # Responses in THIS batch with no scorable text (skipped/blank open-text
    # answer) never appear in `texts`, even when their batch-mates do — fixed
    # 2026-07-14. Previously only an ENTIRELY empty batch (checked below) got
    # marked done; a MIXED batch left the non-answering responses with
    # ai_enriched_at permanently NULL, so _fetch_untagged_responses's
    # ORDER BY submitted_at ASC kept re-selecting those exact same unscoreable
    # oldest rows on every future sweep, forever — crowding out (or in a big
    # enough backlog, fully blocking) genuinely-untagged newer responses behind
    # them, the same class of livelock the 2026-07-13 quarantine fix addressed
    # for actual failures.
    texted_rids = {str(t["response_id"]) for t in texts}
    no_text_ids = [str(r["id"]) for r in responses if str(r["id"]) not in texted_rids]
    if no_text_ids:
        await _mark_enriched_no_text(no_text_ids, conn)
        await conn.commit()
        result["tagged"] += len(no_text_ids)

    if not texts:
        return result

    # "Topic orphans" (added 2026-07-14): a response already fully scored
    # (ai_sentiment/ai_emotion/ai_effort_score all present) that only reached
    # this batch because its ai_topics is still NULL — e.g. it was swept
    # before this survey's topic centroids existed, or its cluster fell below
    # min_cluster_size on a prior run (`_fetch_untagged_responses`'s
    # include_retriable docstring; `graphs/insights.py` calls the same thing
    # a "bootstrap orphan"). Re-running ABSA for these would re-pay an LLM
    # call for an answer we already have — only topic assignment below is
    # actually missing for them.
    orphan_rids = {
        str(r["id"]) for r in responses
        if r.get("ai_sentiment") is not None
        and r.get("ai_emotion") is not None
        and r.get("ai_effort_score") is not None
    } & texted_rids

    tagged_texts = [{**t, "org_id": org_id, "survey_id": survey_id} for t in texts]
    try:
        embedded_texts = await get_or_create_embeddings(tagged_texts, conn)
    except Exception as exc:
        logger.warning("response_tagging_embed_failed", survey_id=survey_id, error=str(exc))
        embedded_texts = tagged_texts

    # Only score text belonging to NON-orphan responses via ABSA — orphans'
    # sentiment/emotion/effort is already correct and must not be overwritten
    # (or re-charged for) just to fix their missing topics.
    scoring_texts = [t for t in embedded_texts if str(t["response_id"]) not in orphan_rids]

    llm_results = []
    if scoring_texts:
        absa_cfg = get_absa_config()
        llm_results = await run_absa_llm(
            scoring_texts, _llm_raw,
            batch_size=absa_cfg["batch_size"],
            semaphore=asyncio.Semaphore(absa_cfg["concurrency"]),
        )

    by_resp: dict[str, list] = defaultdict(list)
    for r in llm_results:
        by_resp[str(r["response_id"])].append(r)

    sentiment_updates = []
    for resp_id, items in by_resp.items():
        avg_score = sum(i.get("score", 0.0) for i in items) / len(items)
        negs = sum(1 for i in items if i.get("sentiment") == "negative")
        pos  = sum(1 for i in items if i.get("sentiment") == "positive")
        dom_sentiment = "negative" if negs > pos else ("positive" if pos > negs else "neutral")
        emotion_counts: dict[str, int] = {}
        for i in items:
            e = i.get("emotion", "neutral")
            emotion_counts[e] = emotion_counts.get(e, 0) + 1
        dom_emotion = max(emotion_counts, key=emotion_counts.get) if emotion_counts else "neutral"
        effort = compute_effort_score([i["text"] for i in items])
        sentiment_updates.append(
            (dom_sentiment, round(avg_score, 2), dom_emotion, round(effort, 1), resp_id)
        )

    if sentiment_updates:
        try:
            async with conn.cursor() as cur:
                await cur.executemany(
                    """UPDATE responses
                       SET ai_sentiment=%s, ai_sentiment_score=%s,
                           ai_emotion=%s, ai_effort_score=%s, ai_enriched_at=NOW()
                       WHERE id=%s""",
                    sentiment_updates,
                )
            # Commit sentiment/emotion/effort writeback IMMEDIATELY, before
            # touching topic assignment below — fixed 2026-07-13. A topic-side
            # failure (isolated by its own try/except further down) must never
            # be able to roll back scoring that already succeeded.
            await conn.commit()
            # += , not = : a mixed batch may have already counted this
            # batch's no-scorable-text responses into result["tagged"] above.
            result["tagged"] += len(sentiment_updates)
        except Exception as exc:
            # RAISES (fixed 2026-07-13, independent review finding): this used
            # to swallow the failure here without incrementing
            # ai_tagging_attempts, so a deterministically-failing writeback
            # (e.g. a persistent constraint violation) left those rows with
            # neither a score NOR a recorded attempt — exactly the oldest-
            # first-forever livelock this whole fix set exists to eliminate,
            # left uncovered for the one section given its own commit
            # boundary. Propagating routes it through the caller's per-row
            # isolation fallback, which DOES record the attempt.
            logger.error("response_tagging_sentiment_writeback_failed",
                         survey_id=survey_id, error=str(exc))
            raise

    # ── Topic assignment — existing topics only (see module docstring) ──────
    # Keyed per OPEN-TEXT ANSWER ("response_id::question_id"), not deduped to
    # one embedding per response (fixed 2026-07-06) — a response with two
    # open-text questions about two different things can genuinely match two
    # different existing topics. assign_batch_to_nearest itself doesn't care
    # about key shape; group_assignments_by_response regroups the per-answer
    # results back to a per-response topic list afterward.
    try:
        # Eligible for topic assignment: responses freshly scored THIS batch
        # (`by_resp`) PLUS orphans (added 2026-07-14) — already correctly
        # scored before, ABSA deliberately skipped for them above, so they'd
        # never otherwise reach this section and their whole reason for being
        # in this batch (fixing JUST the missing topics) would silently no-op.
        topic_eligible_rids = set(by_resp.keys()) | orphan_rids
        if await topic_registry.has_centroids(survey_id, conn):
            embeddings_by_key: dict[str, list[float]] = {
                f"{item['response_id']}::{item['question_id']}": item["embedding"]
                for item in embedded_texts
                if str(item["response_id"]) in topic_eligible_rids and item.get("embedding")
            }

            if embeddings_by_key:
                assignments, unassigned_keys = await topic_registry.assign_batch_to_nearest(
                    embeddings_by_key, survey_id, conn,
                )
                if assignments:
                    topics_by_rid = topic_registry.group_assignments_by_response(assignments)
                    topic_updates = [(json.dumps(names), rid) for rid, names in topics_by_rid.items()]
                    topic_emb_groups: dict[str, list[list[float]]] = defaultdict(list)
                    for key, tname in assignments.items():
                        topic_emb_groups[tname].append(embeddings_by_key[key])
                    try:
                        async with conn.cursor() as cur:
                            # ai_topics_pending=FALSE (added 2026-07-15): a
                            # previously-"Uncategorized" orphan that a LATER
                            # manual click successfully matches to an
                            # existing topic must stop showing as pending —
                            # see _flush_and_discover_topics's identical
                            # clear for the discovery-promotion path.
                            await cur.executemany(
                                "UPDATE responses SET ai_topics=%s, ai_topics_pending=FALSE WHERE id=%s",
                                topic_updates,
                            )
                        await topic_registry.update_centroids_welford_batch(
                            survey_id, topic_emb_groups, conn,
                        )
                        result["topics_assigned"] = len(topic_updates)
                        # An orphan never went through sentiment_updates above,
                        # so it's never counted in `tagged` there — without
                        # this, a run that only fixes orphans' missing topics
                        # would report "0 responses tagged" to the user even
                        # though it genuinely did the work (added 2026-07-14).
                        result["tagged"] += sum(1 for rid in topics_by_rid if rid in orphan_rids)
                    except Exception as exc:
                        logger.error("response_tagging_topic_writeback_failed",
                                     survey_id=survey_id, error=str(exc))

                if unassigned_keys:
                    # At most one candidate per response — topic_candidates has
                    # UNIQUE(survey_id, response_id); see dedupe_unassigned_to_
                    # one_per_response's docstring.
                    cand_pairs = topic_registry.dedupe_unassigned_to_one_per_response(
                        unassigned_keys, embeddings_by_key,
                    )
                    await topic_registry.add_candidates_batch(survey_id, org_id, cand_pairs, conn)
                    result["topics_buffered"] = len(cand_pairs)

            # Checked regardless of whether THIS call added new candidates — the
            # buffer may have already crossed the floor from earlier sweep calls,
            # and skipping this check whenever embeddings_by_rid happens to be
            # empty (e.g. an embed failure this round) would needlessly delay
            # discovery of evidence that's already sitting in the buffer.
            candidate_count = await topic_registry.get_candidate_count(survey_id, conn)
            if candidate_count >= candidate_threshold:
                try:
                    discovered = await _flush_and_discover_topics(
                        survey_id, org_id, conn, questions, by_resp, min_cluster_size,
                    )
                    result["topics_discovered"] = discovered
                except Exception as exc:
                    logger.error("response_tagging_topic_discovery_failed",
                                 survey_id=survey_id, error=str(exc))

        await conn.commit()
    except Exception as exc:
        logger.warning("response_tagging_topic_section_failed",
                        survey_id=survey_id, error=str(exc))

    return result


async def tag_untagged_responses(
    survey_id: str,
    org_id: str,
    max_batch: int = RESPONSE_TAGGING_SWEEP_CAP,
    include_retriable: bool = False,
    has_centroids: bool = False,
) -> dict:
    """Score sentiment/emotion/effort and assign to an existing topic (if any) for
    up to ``max_batch`` untagged responses on this survey. Always queries ALL
    untagged responses for the survey (not just recently-arrived ones), so
    previously-missed or previously-failed responses get swept up on every call.

    ``include_retriable`` (manual Catch Up Tagging only — see
    ``_fetch_untagged_responses``'s docstring): also re-attempts responses that
    already went through this sweep but are still missing sentiment/emotion/
    effort (i.e. were quarantined after repeatedly failing) OR (when
    ``has_centroids`` is also True) are "topic orphans" (fully scored, only
    ``ai_topics`` missing — no re-scoring, only topic assignment runs for
    these). Both default to False so the automatic stream/scheduler sweep
    never retries a response quarantine exists specifically to stop
    retrying. ``has_centroids`` is a plain caller-supplied boolean, not a
    fresh DB check here — the caller (``lib/topic_backfill.py::
    run_topic_backfill``) already computes it once per run via
    ``_has_topics_yet``; recomputing it per call (let alone per row) would be
    redundant.

    New-topic discovery: responses that don't match an existing topic are buffered
    into the same ``topic_candidates`` table ``node_cluster`` already reads from.
    Once that buffer crosses ``TOPIC_DISCOVERY_CANDIDATE_THRESHOLD``, this function
    also flushes it and discovers the new topic itself (see module docstring) —
    it does not wait for a future full pipeline run.

    Never raises — any DB/LLM failure is caught, logged, and simply leaves the
    affected response(s) untagged (or the candidate buffer un-flushed) for the
    next sweep to retry, UNLESS a response has now failed
    ``MAX_RESPONSE_TAGGING_ATTEMPTS`` times, in which case it's quarantined
    (``ai_enriched_at`` set with no scores) so it stops blocking the queue.

    Fault isolation (fixed 2026-07-13, independent review finding): the whole
    fetched batch is tried together first (cheap, common case). If that fails,
    responses are retried ONE AT A TIME so a single poison response can't drag
    its healthy neighbors into quarantine — only the response(s) that ALSO fail
    individually get an attempt recorded. Before this fix, any un-isolated
    exception (e.g. in ``extract_open_texts`` or the sentiment writeback) bumped
    ``ai_tagging_attempts`` for the ENTIRE batch (up to ``RESPONSE_TAGGING_SWEEP_
    CAP`` responses), and after 3 failed sweeps quarantined all of them — silent,
    irrecoverable data loss for responses that were never actually broken.

    Returns ``{tagged, topics_assigned, topics_buffered, topics_discovered,
    skipped_no_survey, failed, quarantined}``.
    """
    result = {
        "tagged": 0, "topics_assigned": 0, "topics_buffered": 0, "topics_discovered": 0,
        "skipped_no_survey": False, "failed": 0, "quarantined": 0,
    }
    responses: list[dict] = []
    try:
        # Resolved BEFORE acquiring the main connection below, not while holding it —
        # each resolver opens its OWN connection internally (lib/insight_settings.py::
        # _fetch_row), and doing that while already inside `async with
        # db._pool_conn().connection()` doubles concurrent connection demand from this
        # function alone. Harmless at low volume, but under a real batch (the exact
        # scenario that surfaced this — fixed 2026-07-06) it can exhaust the pool and
        # cause silent timeouts that this function's own except-everything wrapper
        # then swallows, making topic tagging look like it's simply not running.
        candidate_threshold = await resolve_topic_discovery_candidate_threshold(survey_id, org_id)
        min_cluster_size = await resolve_topic_discovery_min_cluster_size(survey_id, org_id)

        async with db._pool_conn().connection() as conn:
            responses = await _fetch_untagged_responses(
                survey_id, org_id, max_batch, conn,
                include_retriable=include_retriable, has_centroids=has_centroids,
            )
            if not responses:
                return result

            async with conn.cursor() as cur:
                await cur.execute("SELECT questions FROM surveys WHERE id = %s", (survey_id,))
                srow = await cur.fetchone()
            if not srow:
                result["skipped_no_survey"] = True
                return result

            questions = srow[0] or []
            if isinstance(questions, str):
                questions = json.loads(questions)

            try:
                batch_result = await _process_batch(
                    survey_id, org_id, responses, questions, conn, candidate_threshold, min_cluster_size,
                )
                _merge_partial_result(result, batch_result)
            except Exception as exc:
                logger.warning("response_tagging_batch_failed_isolating_rows",
                                survey_id=survey_id, batch_size=len(responses), error=str(exc))
                # Nothing in this batch was committed for a failure originating
                # here (the sentiment writeback either fully succeeds-and-commits
                # or raises before committing) — rollback just clears the
                # connection's aborted-transaction state so it's usable again.
                await conn.rollback()
                for r in responses:
                    try:
                        single_result = await _process_batch(
                            survey_id, org_id, [r], questions, conn, candidate_threshold, min_cluster_size,
                        )
                        _merge_partial_result(result, single_result)
                    except Exception as row_exc:
                        await conn.rollback()
                        result["failed"] += 1
                        quarantined = await _record_batch_failure([str(r["id"])], str(row_exc))
                        result["quarantined"] += len(quarantined)
    except Exception as exc:
        logger.error("response_tagging_sweep_failed", survey_id=survey_id, org_id=org_id, error=str(exc))
        result["failed"] += 1
        response_ids = [str(r["id"]) for r in responses]
        if response_ids:
            quarantined = await _record_batch_failure(response_ids, str(exc))
            result["quarantined"] += len(quarantined)

    logger.info("response_tagging_sweep_done", survey_id=survey_id, org_id=org_id, **result)
    return result
