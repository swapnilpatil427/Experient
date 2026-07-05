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
"""
from __future__ import annotations

import asyncio
import json
from collections import defaultdict

from crystalos.lib import db
from crystalos.lib import topic_registry
from crystalos.lib.logger import logger
from crystalos.lib.constants import RESPONSE_TAGGING_SWEEP_CAP, TOPIC_DISCOVERY_SIMILARITY_THRESHOLD
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


async def _fetch_untagged_responses(survey_id: str, org_id: str, limit: int, conn) -> list[dict]:
    """Untagged = ``ai_enriched_at IS NULL``. Oldest first, so a persistent backlog
    (or a response whose scoring previously failed) surfaces before brand-new ones.
    This is also how "tag any previously missing ones, especially if they failed
    before" is satisfied with no separate failure-tracking state: a failed attempt
    simply never sets ``ai_enriched_at``, so it's naturally retried on the next
    sweep — no dead-letter table or retry counter needed."""
    async with conn.cursor() as cur:
        await cur.execute(
            """SELECT id, answers, nps_score, csat_score, ces_score
               FROM responses
               WHERE survey_id = %s AND org_id = %s AND ai_enriched_at IS NULL
               ORDER BY submitted_at ASC
               LIMIT %s""",
            (survey_id, org_id, limit),
        )
        rows = await cur.fetchall()
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in rows]


async def _mark_enriched_no_text(response_ids: list[str], conn) -> None:
    """A survey with zero open-text questions has nothing for ABSA/topics to score.
    Mark these responses enriched anyway so they stop being re-selected by every
    future sweep forever."""
    if not response_ids:
        return
    async with conn.cursor() as cur:
        await cur.executemany(
            "UPDATE responses SET ai_enriched_at=NOW() WHERE id=%s",
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
            await cur.executemany("UPDATE responses SET ai_topics=%s WHERE id=%s", topic_updates)

    return len(new_topics)


async def tag_untagged_responses(
    survey_id: str,
    org_id: str,
    max_batch: int = RESPONSE_TAGGING_SWEEP_CAP,
) -> dict:
    """Score sentiment/emotion/effort and assign to an existing topic (if any) for
    up to ``max_batch`` untagged responses on this survey. Always queries ALL
    untagged responses for the survey (not just recently-arrived ones), so
    previously-missed or previously-failed responses get swept up on every call.

    New-topic discovery: responses that don't match an existing topic are buffered
    into the same ``topic_candidates`` table ``node_cluster`` already reads from.
    Once that buffer crosses ``TOPIC_DISCOVERY_CANDIDATE_THRESHOLD``, this function
    also flushes it and discovers the new topic itself (see module docstring) —
    it does not wait for a future full pipeline run.

    Never raises — any DB/LLM failure is caught, logged, and simply leaves the
    affected response(s) untagged (or the candidate buffer un-flushed) for the
    next sweep to retry.

    Returns ``{tagged, topics_assigned, topics_buffered, topics_discovered,
    skipped_no_survey, failed}``.
    """
    result = {
        "tagged": 0, "topics_assigned": 0, "topics_buffered": 0, "topics_discovered": 0,
        "skipped_no_survey": False, "failed": 0,
    }
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
            responses = await _fetch_untagged_responses(survey_id, org_id, max_batch, conn)
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

            texts = extract_open_texts(responses, questions)
            if not texts:
                response_ids = [str(r["id"]) for r in responses]
                await _mark_enriched_no_text(response_ids, conn)
                await conn.commit()
                result["tagged"] = len(response_ids)
                return result

            tagged_texts = [{**t, "org_id": org_id, "survey_id": survey_id} for t in texts]
            try:
                embedded_texts = await get_or_create_embeddings(tagged_texts, conn)
            except Exception as exc:
                logger.warning("response_tagging_embed_failed", survey_id=survey_id, error=str(exc))
                embedded_texts = tagged_texts

            absa_cfg = get_absa_config()
            llm_results = await run_absa_llm(
                embedded_texts, _llm_raw,
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
                    result["tagged"] = len(sentiment_updates)
                except Exception as exc:
                    logger.error("response_tagging_sentiment_writeback_failed",
                                 survey_id=survey_id, error=str(exc))
                    result["failed"] += len(sentiment_updates)

            # ── Topic assignment — existing topics only (see docstring) ─────────
            scored_rids = set(by_resp.keys())
            if await topic_registry.has_centroids(survey_id, conn):
                embeddings_by_rid: dict[str, list[float]] = {
                    str(item["response_id"]): item["embedding"]
                    for item in embedded_texts
                    if str(item["response_id"]) in scored_rids and item.get("embedding")
                }

                if embeddings_by_rid:
                    assignments, unassigned_rids = await topic_registry.assign_batch_to_nearest(
                        embeddings_by_rid, survey_id, conn,
                    )
                    if assignments:
                        topic_updates = [(json.dumps([tname]), rid) for rid, tname in assignments.items()]
                        topic_emb_groups: dict[str, list[list[float]]] = defaultdict(list)
                        for rid, tname in assignments.items():
                            topic_emb_groups[tname].append(embeddings_by_rid[rid])
                        try:
                            async with conn.cursor() as cur:
                                await cur.executemany(
                                    "UPDATE responses SET ai_topics=%s WHERE id=%s",
                                    topic_updates,
                                )
                            await topic_registry.update_centroids_welford_batch(
                                survey_id, topic_emb_groups, conn,
                            )
                            result["topics_assigned"] = len(topic_updates)
                        except Exception as exc:
                            logger.error("response_tagging_topic_writeback_failed",
                                         survey_id=survey_id, error=str(exc))

                    if unassigned_rids:
                        cand_pairs = [(rid, embeddings_by_rid[rid]) for rid in unassigned_rids]
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
        logger.error("response_tagging_sweep_failed", survey_id=survey_id, org_id=org_id, error=str(exc))
        result["failed"] += 1

    logger.info("response_tagging_sweep_done", survey_id=survey_id, org_id=org_id, **result)
    return result
