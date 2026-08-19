"""Crystal tool executor functions — each tool queries the DB and returns structured data.

Every executor:
- Enforces org_id scoping on ALL SQL joins (tenant isolation)
- Uses parameterized queries only (no string interpolation)
- Returns {"error": "..."} on failure rather than raising
"""
from __future__ import annotations

import asyncio
import json
import math
import re
import time as _time
import traceback
from typing import Any

from crystalos.crystal.context import CrystalContext
from crystalos.crystal.user_directory_tools import USER_DIRECTORY_EXECUTORS
from crystalos.lib import db
from crystalos.lib.logger import logger
from crystalos.lib.metrics import crystal_tool_calls_total, crystal_tool_duration_seconds


# ── NPS industry benchmarks (static reference table) ─────────────────────────
_NPS_BENCHMARKS = {
    "technology":            {"nps": 35, "source": "Satmetrix 2023"},
    "healthcare":            {"nps": 27, "source": "Satmetrix 2023"},
    "retail":                {"nps": 46, "source": "Satmetrix 2023"},
    "financial_services":    {"nps": 34, "source": "Satmetrix 2023"},
    "education":             {"nps": 47, "source": "Satmetrix 2023"},
    "government":            {"nps": 14, "source": "Satmetrix 2023"},
    "professional_services": {"nps": 43, "source": "Satmetrix 2023"},
    "other":                 {"nps": 32, "source": "Satmetrix 2023"},
}
_CSAT_BENCHMARKS = {
    "technology":            {"csat": 3.9},
    "healthcare":            {"csat": 3.7},
    "retail":                {"csat": 4.0},
    "financial_services":    {"csat": 3.8},
    "education":             {"csat": 4.1},
    "government":            {"csat": 3.5},
    "professional_services": {"csat": 3.9},
    "other":                 {"csat": 3.8},
}


# ── Alert threshold parsing (bug B4) ──────────────────────────────────────────
# The LLM usually passes `condition` as prose ("NPS drops below 30") rather than a
# structured threshold dict. Parse common phrasings into a threshold config so the
# proposed alert ships with a real, actionable threshold instead of an empty one.
_THRESHOLD_BELOW_RE = re.compile(
    r"\b(?:below|under|less\s+than|drops?\s+below|falls?\s+below|fewer\s+than)\b\s*(-?\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
_THRESHOLD_ABOVE_RE = re.compile(
    r"\b(?:above|over|greater\s+than|more\s+than|exceeds?|rises?\s+above|climbs?\s+above)\b\s*(-?\d+(?:\.\d+)?)",
    re.IGNORECASE,
)


def _parse_threshold(condition: str) -> dict | None:
    """Regex-parse prose alert conditions into a threshold config dict.

    "NPS drops below 30" → {"below": 30}; "CSAT above 4.5" → {"above": 4.5}.
    Returns None when nothing parseable is found.
    """
    if not condition or not isinstance(condition, str):
        return None

    def _num(raw: str):
        return float(raw) if "." in raw else int(raw)

    m = _THRESHOLD_BELOW_RE.search(condition)
    if m:
        return {"below": _num(m.group(1))}
    m = _THRESHOLD_ABOVE_RE.search(condition)
    if m:
        return {"above": _num(m.group(1))}
    return None


# Sensible default thresholds per alert-catalog code, used when neither an explicit
# threshold dict nor a parseable condition is supplied. Keeps known alert types from
# shipping with an empty (non-actionable) threshold.
_ALERT_TYPE_DEFAULT_THRESHOLDS: dict[str, dict] = {
    "S-01": {"minDrop": 5, "windowDays": 7},
    "S-03": {"below": 30},
    "S-04": {"below": 3.5},
    "S-05": {"above": 5},
    "T-03": {},
}


async def execute_get_survey_overview(ctx: CrystalContext, params: dict) -> dict:
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        if not survey_id:
            return {"error": "survey_id required"}

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                # Survey metadata
                await cur.execute(
                    """SELECT id, title, status, created_at,
                              (SELECT COUNT(*)::int FROM responses r
                               WHERE r.survey_id = surveys.id) AS response_count
                       FROM surveys WHERE id = %s AND org_id = %s AND deleted_at IS NULL""",
                    (survey_id, ctx.org_id),
                )
                row = await cur.fetchone()
                if not row:
                    return {"error": "survey not found"}
                survey = dict(zip([d[0] for d in cur.description], row))

                # Latest metric snapshot
                await cur.execute(
                    """SELECT nps AS nps_score, csat AS csat_score,
                              effort_score AS ces_score, response_count, captured_at
                       FROM survey_metric_snapshots
                       WHERE survey_id = %s AND org_id = %s
                       ORDER BY captured_at DESC LIMIT 1""",
                    (survey_id, ctx.org_id),
                )
                snap_row = await cur.fetchone()
                snapshot = dict(zip([d[0] for d in cur.description], snap_row)) if snap_row else {}

                # Top topics
                await cur.execute(
                    """SELECT name, volume, sentiment_score, dominant_emotion, trending
                       FROM survey_topics
                       WHERE survey_id = %s AND org_id = %s AND time_window = 'all_time'
                       ORDER BY volume DESC LIMIT 5""",
                    (survey_id, ctx.org_id),
                )
                topics = [dict(zip([d[0] for d in cur.description], r)) for r in await cur.fetchall()]

        return {
            "survey": {k: str(v) if hasattr(v, 'isoformat') else v for k, v in survey.items()},
            "metrics": {k: float(v) if v is not None else None for k, v in snapshot.items() if k != 'captured_at'},
            "top_topics": topics,
        }
    except Exception as exc:
        logger.error("tool_get_survey_overview_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_topic_details(ctx: CrystalContext, params: dict) -> dict:
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        topic_name = params.get("topic_name")
        limit = min(int(params.get("limit", 10)), 30)
        if not survey_id or not topic_name:
            return {"error": "survey_id and topic_name required"}

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT name, volume, sentiment_score, dominant_emotion, effort_score,
                              trending, nps_avg, positive_pct, negative_pct
                       FROM survey_topics
                       WHERE survey_id = %s AND org_id = %s AND name ILIKE %s AND time_window = 'all_time'
                       LIMIT 1""",
                    (survey_id, ctx.org_id, f"%{topic_name}%"),
                )
                row = await cur.fetchone()
                topic = dict(zip([d[0] for d in cur.description], row)) if row else {}

                # Sample verbatims from responses with this topic tag
                await cur.execute(
                    """SELECT r.answers, r.ai_sentiment, r.ai_sentiment_score
                       FROM responses r
                       WHERE r.survey_id = %s
                         AND r.ai_topics::text ILIKE %s
                       ORDER BY r.submitted_at DESC
                       LIMIT %s""",
                    (survey_id, f'%{topic_name}%', limit),
                )
                verbatim_rows = await cur.fetchall()

        verbatims = []
        for vr in verbatim_rows:
            answers = vr[0]
            if isinstance(answers, str):
                try: answers = json.loads(answers)
                except Exception: answers = []
            texts = [a.get("value", "") for a in (answers or []) if isinstance(a.get("value"), str) and a.get("value")]
            if texts:
                verbatims.append({
                    "text": texts[0][:300],
                    "sentiment": vr[1],
                    "score": float(vr[2]) if vr[2] is not None else None,
                })

        return {"topic": topic, "verbatims": verbatims, "verbatim_count": len(verbatims)}
    except Exception as exc:
        logger.error("tool_get_topic_details_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_metric_history(ctx: CrystalContext, params: dict) -> dict:
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        metric = params.get("metric", "all")
        days = min(int(params.get("days", 90)), 365)
        if not survey_id:
            return {"error": "survey_id required"}

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT nps AS nps_score, csat AS csat_score,
                              effort_score AS ces_score, response_count, captured_at
                       FROM survey_metric_snapshots
                       WHERE survey_id = %s AND org_id = %s
                         AND captured_at > NOW() - (%s * INTERVAL '1 day')
                       ORDER BY captured_at ASC""",
                    (survey_id, ctx.org_id, days),
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]

        data = [dict(zip(cols, r)) for r in rows]
        for item in data:
            for k in ("nps_score", "csat_score", "ces_score"):
                if item.get(k) is not None:
                    item[k] = float(item[k])
            if item.get("captured_at"):
                item["captured_at"] = str(item["captured_at"])

        return {"history": data, "count": len(data), "days": days}
    except Exception as exc:
        logger.error("tool_get_metric_history_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_insights_list(ctx: CrystalContext, params: dict) -> dict:
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        layer = params.get("layer", "all")
        time_window = params.get("time_window", "all_time")
        limit = min(int(params.get("limit", 20)), 50)
        if not survey_id:
            return {"error": "survey_id required"}

        conditions = ["survey_id = %s", "org_id = %s", "superseded_at IS NULL"]
        args: list = [survey_id, ctx.org_id]
        if layer != "all":
            conditions.append("layer = %s")
            args.append(layer)
        if time_window != "all_time":
            conditions.append("time_window = %s")
            args.append(time_window)
        args.append(limit)

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    f"""SELECT id, layer, category, headline, narrative, trust_score, metric_json
                        FROM insights WHERE {' AND '.join(conditions)}
                        ORDER BY priority DESC NULLS LAST, trust_score DESC NULLS LAST
                        LIMIT %s""",
                    args,
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]

        insights = []
        for row in rows:
            ins = dict(zip(cols, row))
            ins["id"] = str(ins["id"])
            if ins.get("trust_score") is not None:
                ins["trust_score"] = int(ins["trust_score"])
            insights.append(ins)

        return {"insights": insights, "count": len(insights)}
    except Exception as exc:
        logger.error("tool_get_insights_list_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_verbatims(ctx: CrystalContext, params: dict) -> dict:
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        topic_name = params.get("topic_name")
        sentiment = params.get("sentiment", "all")
        limit = min(int(params.get("limit", 15)), 50)
        if not survey_id:
            return {"error": "survey_id required"}

        conditions = ["survey_id = %s", "org_id = %s"]
        args: list = [survey_id, ctx.org_id]
        if topic_name:
            conditions.append("ai_topics::text ILIKE %s")
            args.append(f"%{topic_name}%")
        if sentiment != "all":
            conditions.append("ai_sentiment = %s")
            args.append(sentiment)
        args.append(limit)

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    f"""SELECT answers, ai_sentiment, ai_sentiment_score, submitted_at
                        FROM responses WHERE {' AND '.join(conditions)}
                        ORDER BY submitted_at DESC LIMIT %s""",
                    args,
                )
                rows = await cur.fetchall()

        verbatims = []
        for row in rows:
            answers = row[0]
            if isinstance(answers, str):
                try: answers = json.loads(answers)
                except Exception: answers = []
            texts = [a.get("value", "") for a in (answers or []) if isinstance(a.get("value"), str) and a.get("value")]
            if texts:
                verbatims.append({
                    "text": texts[0][:400],
                    "sentiment": row[1],
                    "score": float(row[2]) if row[2] is not None else None,
                    "submitted_at": str(row[3]) if row[3] else None,
                })

        return {"verbatims": verbatims, "count": len(verbatims)}
    except Exception as exc:
        logger.error("tool_get_verbatims_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_benchmark_comparison(ctx: CrystalContext, params: dict) -> dict:
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        metric = params.get("metric", "nps")
        industry = params.get("industry")

        if not industry:
            # Load from org profile
            async with db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "SELECT industry FROM org_profiles WHERE org_id = %s",
                        (ctx.org_id,),
                    )
                    row = await cur.fetchone()
                    industry = (row[0] if row else None) or "other"

        # Get current metric value
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT nps, csat FROM survey_metric_snapshots
                       WHERE survey_id = %s AND org_id = %s
                       ORDER BY captured_at DESC LIMIT 1""",
                    (survey_id, ctx.org_id),
                )
                row = await cur.fetchone()

        current_value = None
        if row:
            current_value = float(row[0]) if metric == "nps" and row[0] is not None else (
                float(row[1]) if metric == "csat" and row[1] is not None else None
            )

        benchmark = _NPS_BENCHMARKS.get(industry, _NPS_BENCHMARKS["other"]) if metric == "nps" else \
                    _CSAT_BENCHMARKS.get(industry, _CSAT_BENCHMARKS["other"])

        benchmark_value = benchmark.get(metric)
        delta = (current_value - benchmark_value) if (current_value is not None and benchmark_value is not None) else None

        return {
            "metric": metric,
            "industry": industry,
            "current_value": current_value,
            "benchmark": benchmark_value,
            "delta": round(delta, 1) if delta is not None else None,
            "source": benchmark.get("source", "Industry benchmark"),
            "above_benchmark": delta > 0 if delta is not None else None,
        }
    except Exception as exc:
        logger.error("tool_get_benchmark_comparison_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_driver_analysis(ctx: CrystalContext, params: dict) -> dict:
    """Returns driver scores on -100 to +100 NPS scale (not 0-10)."""
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        if not survey_id:
            return {"error": "survey_id required"}

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT name, volume, nps_avg, sentiment_score, effort_score
                       FROM survey_topics
                       WHERE survey_id = %s AND org_id = %s AND time_window = 'all_time'
                       ORDER BY volume DESC LIMIT 10""",
                    (survey_id, ctx.org_id),
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]

        drivers = []
        for row in rows:
            t = dict(zip(cols, row))
            # Convert nps_avg to -100..+100 scale if it's stored differently
            nps_avg = float(t.get("nps_avg") or 0)
            # Normalize sentiment_score (-1..1) to nps-scale (-100..+100) for driver impact
            sentiment = float(t.get("sentiment_score") or 0)
            driver_impact = round(sentiment * 100, 1)  # -100 to +100 scale
            drivers.append({
                "topic": t["name"],
                "volume": int(t.get("volume") or 0),
                "nps_avg": nps_avg,
                "driver_impact": driver_impact,  # -100 to +100 NPS scale
                "effort_score": float(t.get("effort_score") or 0),
            })

        # Sort by absolute driver impact (biggest movers first)
        drivers.sort(key=lambda x: abs(x["driver_impact"]), reverse=True)
        return {"drivers": drivers, "count": len(drivers)}
    except Exception as exc:
        logger.error("tool_get_driver_analysis_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


_SEGMENTABLE_QUESTION_TYPES = {"multiple_choice", "checkbox", "dropdown", "rating", "nps", "csat"}


async def _load_segmentable_questions(cur, survey_id: str, org_id: str) -> list[dict]:
    """Return [{id, text, type}] for questions usable as segments. cur is an open cursor."""
    await cur.execute(
        "SELECT questions FROM surveys WHERE id = %s AND org_id = %s AND deleted_at IS NULL",
        (survey_id, org_id),
    )
    row = await cur.fetchone()
    if not row or not row[0]:
        return []
    questions = row[0]
    if isinstance(questions, str):
        try:
            questions = json.loads(questions)
        except Exception:
            return []
    out = []
    for q in (questions or []):
        if not isinstance(q, dict):
            continue
        if q.get("type") in _SEGMENTABLE_QUESTION_TYPES:
            out.append({
                "id": str(q.get("id", "")),
                "text": q.get("question", ""),
                "type": q.get("type", ""),
            })
    return out


async def execute_list_segmentable_questions(ctx: CrystalContext, params: dict) -> dict:
    """List questions that can be used to segment responses (choice/scale types)."""
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        if not survey_id:
            return {"error": "survey_id required"}
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                questions = await _load_segmentable_questions(cur, survey_id, ctx.org_id)
        return {"questions": questions, "count": len(questions)}
    except Exception as exc:
        logger.error("tool_list_segmentable_questions_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_segment_breakdown(ctx: CrystalContext, params: dict) -> dict:
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        segment_question_id = params.get("segment_question_id")
        segment_question_text = params.get("segment_question_text")
        metric = params.get("metric", "sentiment")
        if not survey_id:
            return {"error": "survey_id required"}

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                # Resolve a segment by question text when no id was supplied.
                if not segment_question_id:
                    segmentable = await _load_segmentable_questions(cur, survey_id, ctx.org_id)
                    if segment_question_text:
                        needle = segment_question_text.strip().lower()
                        match = next(
                            (q for q in segmentable if needle in (q["text"] or "").lower()), None
                        )
                        if match:
                            segment_question_id = match["id"]
                    if not segment_question_id:
                        return {
                            "error": "segment_question_id or a matching segment_question_text required",
                            "available_segments": segmentable,
                        }

                await cur.execute(
                    "SELECT answers, ai_sentiment, ai_sentiment_score, nps_score FROM responses WHERE survey_id = %s AND org_id = %s ORDER BY submitted_at DESC LIMIT 500",
                    (survey_id, ctx.org_id),
                )
                rows = await cur.fetchall()

        segments: dict[str, list] = {}
        for row in rows:
            answers = row[0]
            if isinstance(answers, str):
                try: answers = json.loads(answers)
                except Exception: answers = []
            segment_value = None
            for a in (answers or []):
                qid = a.get("questionId") or a.get("question_id")
                if str(qid) == str(segment_question_id):
                    segment_value = str(a.get("value", "unknown"))
                    break
            if segment_value:
                segments.setdefault(segment_value, []).append({
                    "sentiment": row[1], "score": float(row[2]) if row[2] else 0,
                    "nps_score": int(row[3]) if row[3] is not None else None,
                })

        result = []
        for seg_value, responses_list in segments.items():
            n = len(responses_list)
            avg_sentiment = sum(r["score"] for r in responses_list) / n if n else 0
            nps_scores = [r["nps_score"] for r in responses_list if r["nps_score"] is not None]
            nps_avg = sum(nps_scores) / len(nps_scores) if nps_scores else None
            result.append({
                "segment": seg_value,
                "count": n,
                "avg_sentiment_score": round(avg_sentiment, 2),
                "nps_avg": round(nps_avg, 1) if nps_avg is not None else None,
            })

        result.sort(key=lambda x: x["count"], reverse=True)
        return {"segments": result, "segment_count": len(result)}
    except Exception as exc:
        logger.error("tool_get_segment_breakdown_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def _v2_then_legacy_rows(
    survey_id: str, org_id: str, limit: int, v2_select: str, legacy_select: str,
) -> list[dict]:
    """Shared v2-first / legacy-fallback row loader.

    Fixed 2026-07-04: execute_get_checkpoint_history and execute_get_recent_checkpoints
    used to query ONLY survey_insight_checkpoints (legacy), found during the same audit
    that fixed node_delta_compute's identical mistake (graphs/insights.py) — any survey
    whose history has moved to insight_checkpoints_v2 (and especially once
    STOP_LEGACY_CHECKPOINT_WRITE is ever enabled) would silently get empty results from
    these tools. execute_get_checkpoint_chain/get_insight_trail already used this
    v2-first-with-fallback shape; this factors it out for the two callers below instead
    of hand-rolling a third and fourth copy.
    """
    rows: list[dict] = []
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    f"""SELECT {v2_select}
                        FROM insight_checkpoints_v2
                        WHERE survey_id = %s AND org_id = %s AND lane = 'automated'
                        ORDER BY checkpoint_number DESC
                        LIMIT %s""",
                    (survey_id, org_id, limit),
                )
                fetched = await cur.fetchall()
                if fetched:
                    cols = [d[0] for d in cur.description]
                    rows = [dict(zip(cols, r)) for r in fetched]
    except Exception as exc:
        logger.debug("checkpoint_rows_v2_unavailable", survey_id=survey_id, error=str(exc))
        rows = []

    if not rows:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    f"""SELECT {legacy_select}
                        FROM survey_insight_checkpoints
                        WHERE survey_id = %s AND org_id = %s
                        ORDER BY checkpoint_number DESC
                        LIMIT %s""",
                    (survey_id, org_id, limit),
                )
                fetched = await cur.fetchall()
                cols = [d[0] for d in cur.description]
                rows = [dict(zip(cols, r)) for r in fetched]

    return rows


async def execute_get_checkpoint_history(ctx: CrystalContext, params: dict) -> dict:
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        limit = min(int(params.get("limit", 5)), 20)
        if not survey_id:
            return {"error": "survey_id required"}

        cols = ("id, checkpoint_number, response_count_at_checkpoint, "
                "nps_at_checkpoint, csat_at_checkpoint, topic_fingerprint, "
                "delta_from_prior, created_at")
        rows = await _v2_then_legacy_rows(survey_id, ctx.org_id, limit, cols, cols)

        checkpoints = []
        for row in rows:
            cp = dict(row)
            cp["id"] = str(cp["id"])
            if cp.get("created_at"):
                cp["created_at"] = str(cp["created_at"])
            for k in ("nps_at_checkpoint", "csat_at_checkpoint"):
                if cp.get(k) is not None:
                    cp[k] = float(cp[k])
            checkpoints.append(cp)

        return {"checkpoints": checkpoints, "count": len(checkpoints)}
    except Exception as exc:
        logger.error("tool_get_checkpoint_history_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_recent_checkpoints(ctx: CrystalContext, params: dict) -> dict:
    """Return the most recent insight checkpoints with delta_from_prior + meaningful_delta.

    Phase 0.5 (Insight Pipeline v2) read tool — surfaces the code-computed delta so
    Crystal can narrate "what changed since the last checkpoint". v2-first with legacy
    fallback (see _v2_then_legacy_rows).
    """
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        limit = min(int(params.get("limit", 5)), 20)
        if not survey_id:
            return {"error": "survey_id required"}

        cols = "checkpoint_number, nps_at_checkpoint, delta_from_prior, meaningful_delta, created_at"
        rows = await _v2_then_legacy_rows(survey_id, ctx.org_id, limit, cols, cols)

        checkpoints = []
        for row in rows:
            cp = dict(row)
            if cp.get("created_at"):
                cp["created_at"] = str(cp["created_at"])
            if cp.get("nps_at_checkpoint") is not None:
                cp["nps_at_checkpoint"] = float(cp["nps_at_checkpoint"])
            delta = cp.get("delta_from_prior")
            if isinstance(delta, str):
                try:
                    cp["delta_from_prior"] = json.loads(delta)
                except Exception:
                    cp["delta_from_prior"] = None
            checkpoints.append(cp)

        return {"checkpoints": checkpoints, "count": len(checkpoints)}
    except Exception as exc:
        logger.error("tool_get_recent_checkpoints_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_compare_surveys(ctx: CrystalContext, params: dict) -> dict:
    try:
        survey_id_a = params.get("survey_id_a")
        survey_id_b = params.get("survey_id_b")
        if not survey_id_a or not survey_id_b:
            return {"error": "survey_id_a and survey_id_b required"}

        results = {}
        for sid, label in [(survey_id_a, "a"), (survey_id_b, "b")]:
            async with db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """SELECT title,
                                  (SELECT COUNT(*)::int FROM responses r
                                   WHERE r.survey_id = surveys.id) AS response_count
                           FROM surveys
                           WHERE id = %s AND org_id = %s AND deleted_at IS NULL""",
                        (sid, ctx.org_id),
                    )
                    row = await cur.fetchone()
                    if not row:
                        return {"error": f"Survey {sid} not found for org"}
                    results[label] = {"survey_id": sid, "title": row[0], "response_count": row[1]}

                    await cur.execute(
                        """SELECT nps, csat, effort_score FROM survey_metric_snapshots
                           WHERE survey_id = %s AND org_id = %s ORDER BY captured_at DESC LIMIT 1""",
                        (sid, ctx.org_id),
                    )
                    snap = await cur.fetchone()
                    if snap:
                        results[label].update({
                            "nps": float(snap[0]) if snap[0] is not None else None,
                            "csat": float(snap[1]) if snap[1] is not None else None,
                            "ces": float(snap[2]) if snap[2] is not None else None,
                        })

        delta = {}
        for metric in ("nps", "csat", "ces"):
            a_val = results.get("a", {}).get(metric)
            b_val = results.get("b", {}).get(metric)
            if a_val is not None and b_val is not None:
                delta[metric] = round(a_val - b_val, 1)

        return {"survey_a": results.get("a", {}), "survey_b": results.get("b", {}), "delta": delta}
    except Exception as exc:
        logger.error("tool_compare_surveys_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_org_portfolio(ctx: CrystalContext, params: dict) -> dict:
    try:
        limit = min(int(params.get("limit", 10)), 50)
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT s.id, s.title, s.status,
                              (SELECT COUNT(*)::int FROM responses r
                               WHERE r.survey_id = s.id) AS response_count,
                              m.nps_score, m.csat_score
                       FROM surveys s
                       LEFT JOIN LATERAL (
                           SELECT nps AS nps_score, csat AS csat_score
                           FROM survey_metric_snapshots
                           WHERE survey_id = s.id ORDER BY captured_at DESC LIMIT 1
                       ) m ON true
                       WHERE s.org_id = %s AND s.status = 'active' AND s.deleted_at IS NULL
                       ORDER BY response_count DESC NULLS LAST
                       LIMIT %s""",
                    (ctx.org_id, limit),
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]

        surveys = []
        for row in rows:
            s = dict(zip(cols, row))
            s["id"] = str(s["id"])
            for k in ("nps_score", "csat_score"):
                if s.get(k) is not None:
                    s[k] = float(s[k])
            surveys.append(s)

        return {"surveys": surveys, "active_survey_count": len(surveys)}
    except Exception as exc:
        logger.error("tool_get_org_portfolio_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_cross_survey_themes(ctx: CrystalContext, params: dict) -> dict:
    try:
        min_survey_count = int(params.get("min_survey_count", 2))
        limit = min(int(params.get("limit", 10)), 30)

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT name, COUNT(DISTINCT survey_id) as survey_count, SUM(volume) as total_volume,
                              AVG(sentiment_score) as avg_sentiment
                       FROM survey_topics
                       WHERE org_id = %s AND time_window = 'all_time'
                       GROUP BY name
                       HAVING COUNT(DISTINCT survey_id) >= %s
                       ORDER BY survey_count DESC, total_volume DESC
                       LIMIT %s""",
                    (ctx.org_id, min_survey_count, limit),
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]

        themes = []
        for row in rows:
            t = dict(zip(cols, row))
            t["survey_count"] = int(t["survey_count"])
            t["total_volume"] = int(t["total_volume"] or 0)
            t["avg_sentiment"] = round(float(t["avg_sentiment"] or 0), 2)
            themes.append(t)

        return {"themes": themes, "count": len(themes)}
    except Exception as exc:
        logger.error("tool_get_cross_survey_themes_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_anomaly_events(ctx: CrystalContext, params: dict) -> dict:
    try:
        survey_id = params.get("survey_id")
        days = min(int(params.get("days", 30)), 365)
        limit = min(int(params.get("limit", 10)), 50)

        conditions = ["org_id = %s", "captured_at > NOW() - (%s * INTERVAL '1 day')"]
        args: list = [ctx.org_id, days]
        if survey_id:
            conditions.append("survey_id = %s")
            args.append(survey_id)
        # Filter for significant metric drops (anomalies)
        conditions.append("(nps < -10 OR csat < 2.5 OR anomaly_flag = true)")
        args.append(limit)

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    f"""SELECT survey_id, nps AS nps_score, csat AS csat_score,
                               response_count, captured_at
                        FROM survey_metric_snapshots
                        WHERE {' AND '.join(conditions)}
                        ORDER BY captured_at DESC LIMIT %s""",
                    args,
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]

        events = []
        for row in rows:
            e = dict(zip(cols, row))
            e["survey_id"] = str(e["survey_id"])
            if e.get("captured_at"):
                e["captured_at"] = str(e["captured_at"])
            for k in ("nps_score", "csat_score"):
                if e.get(k) is not None:
                    e[k] = float(e[k])
            events.append(e)

        return {"events": events, "count": len(events)}
    except Exception as exc:
        logger.error("tool_get_anomaly_events_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


# ── Action tool executors ─────────────────────────────────────────────────────
# These tools return PROPOSALS (structured JSON) for the frontend to execute
# after user confirmation. Crystal never autonomously mutates survey data.

async def execute_recommend_next_actions(ctx: CrystalContext, params: dict) -> dict:
    """Run the action-recommender skill to surface next-step proposals."""
    try:
        survey_id  = params.get("survey_id") or ctx.survey_id
        focus_area = params.get("focus_area", "")

        # Gather context for the skill
        survey_data: dict = {}
        topics: list[dict] = []
        insights: list[dict] = []
        metrics: dict = {}

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                # Survey metadata
                await cur.execute(
                    "SELECT title, status FROM surveys WHERE id = %s AND org_id = %s AND deleted_at IS NULL",
                    (survey_id, ctx.org_id),
                )
                row = await cur.fetchone()
                if row:
                    survey_data = {"title": row[0], "status": row[1]}

                # Top topics (by urgency)
                await cur.execute(
                    """SELECT name, sentiment_score, volume, urgency_score, trending
                       FROM survey_topics WHERE survey_id = %s AND org_id = %s
                       ORDER BY urgency_score DESC NULLS LAST LIMIT 8""",
                    (survey_id, ctx.org_id),
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]
                topics = [dict(zip(cols, r)) for r in rows]
                for t in topics:
                    for k in ("sentiment_score", "urgency_score"):
                        if t.get(k) is not None:
                            t[k] = float(t[k])

                # Top insights
                await cur.execute(
                    """SELECT layer, headline, trust_score FROM insights
                       WHERE survey_id = %s AND org_id = %s AND superseded_at IS NULL
                       ORDER BY trust_score DESC NULLS LAST LIMIT 8""",
                    (survey_id, ctx.org_id),
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]
                insights = [dict(zip(cols, r)) for r in rows]

                # Latest metric snapshot
                await cur.execute(
                    """SELECT nps, csat, effort_score, response_count
                       FROM survey_metric_snapshots WHERE survey_id = %s AND org_id = %s
                       ORDER BY captured_at DESC LIMIT 1""",
                    (survey_id, ctx.org_id),
                )
                snap = await cur.fetchone()
                if snap:
                    metrics = {
                        "nps":  {"score": float(snap[0]) if snap[0] is not None else None, "n": snap[3] or 0},
                        "csat": {"score": float(snap[1]) if snap[1] is not None else None},
                        "ces":  {"score": float(snap[2]) if snap[2] is not None else None},
                    }

        # Invoke the action-recommender skill
        from crystalos.lib.skill_registry import get_registry as _get_reg
        reg = _get_reg()
        if not reg.is_initialized() or not reg.get_skill_meta("action-recommender"):
            return {"error": "action-recommender skill not initialized"}

        skill_input = {
            "survey_id":     survey_id,
            "survey_type":   "custom",
            "survey_title":  survey_data.get("title", ""),
            "org_context":   {"industry": None, "company_size": None, "audience": "customers"},
            "metrics":       metrics,
            "top_themes":    [
                {
                    "label":           t.get("name", ""),
                    "sentiment_score": t.get("sentiment_score", 0.0),
                    "volume_pct":      (t.get("volume") or 0) / max(1, sum(x.get("volume") or 0 for x in topics)),
                    "urgency_score":   t.get("urgency_score", 0.5),
                    "trending":        t.get("trending"),
                }
                for t in topics
            ],
            "key_insights":          insights,
            "conversation_history":  [],
            "response_count":        metrics.get("nps", {}).get("n", 0),
            "existing_surveys":      [],
        }
        if focus_area:
            skill_input["focus_area"] = focus_area

        result = await reg.execute(
            "action-recommender",
            skill_input,
            {"org_id": ctx.org_id, "survey_id": survey_id},
        )
        return result.get("output", {"error": "No recommendations generated"})
    except Exception as exc:
        logger.error("tool_recommend_actions_failed", error=str(exc))
        return {"error": str(exc)}


async def execute_propose_survey_creation(ctx: CrystalContext, params: dict) -> dict:
    """Propose a new follow-up survey — returns structured proposal for frontend confirmation."""
    purpose           = params.get("purpose", "")
    target_audience   = params.get("target_audience", "customers")
    survey_type       = params.get("survey_type", "custom")
    source_survey_id  = params.get("survey_id") or ctx.survey_id

    # Get source survey context
    survey_title = ""
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT title FROM surveys WHERE id = %s AND org_id = %s AND deleted_at IS NULL",
                    (source_survey_id, ctx.org_id),
                )
                row = await cur.fetchone()
                if row:
                    survey_title = row[0]
    except Exception:
        pass

    intent = (
        f"{purpose}. "
        f"Target audience: {target_audience}. "
        f"Based on learnings from: {survey_title or 'current survey'}."
    )

    return {
        "proposal_type": "create_survey",
        "title": f"Create follow-up {survey_type} survey",
        "description": f"New survey targeting {target_audience}: {purpose}",
        "requires_confirmation": True,
        "params": {
            "intent":       intent,
            "survey_type":  survey_type,
            "audience":     target_audience,
        },
        "estimated_time": "5 minutes to review and launch",
        "cta_label": "Create Survey",
        "business_rationale": (
            f"Captures targeted feedback from {target_audience} on {purpose or 'this area'} "
            f"so the team can validate the issue and prioritise the right fix."
        )[:159],
    }


async def execute_propose_survey_edit(ctx: CrystalContext, params: dict) -> dict:
    """Propose edits to the current survey — questions to add or rephrase."""
    survey_id   = params.get("survey_id") or ctx.survey_id
    edit_request = params.get("edit_request", "")
    focus_topic  = params.get("focus_topic", "")

    # Suggest 1-3 specific questions based on edit_request + focus_topic
    suggested_questions: list[str] = []
    if focus_topic:
        suggested_questions = [
            f"What specifically about {focus_topic} was most frustrating?",
            f"How would you rate {focus_topic} on a scale of 1-5?",
            f"What would improve your experience with {focus_topic}?",
        ]
    else:
        suggested_questions = [
            "What is the most important improvement we could make?",
            "How likely are you to continue using our product after this experience?",
        ]

    return {
        "proposal_type": "edit_survey",
        "title": "Add questions to current survey",
        "description": f"Proposed edit: {edit_request}",
        "requires_confirmation": True,
        "params": {
            "survey_id":          survey_id,
            "message":            edit_request,
            "questions_to_add":   suggested_questions[:2],
        },
        "estimated_time": "2 minutes",
        "cta_label": "Apply Edits",
        "business_rationale": (
            f"Closes the measurement gap around {focus_topic or 'this theme'} so future "
            f"responses pinpoint the root cause instead of leaving it ambiguous."
        )[:159],
    }


async def execute_propose_distribution(ctx: CrystalContext, params: dict) -> dict:
    """Propose a targeted distribution campaign for the survey."""
    survey_id      = params.get("survey_id") or ctx.survey_id
    target_segment = params.get("target_segment", "all respondents")
    goal           = params.get("goal", "gather additional feedback")

    # Recommend channel based on segment
    if "detractor" in target_segment.lower() or "churned" in target_segment.lower():
        recommended_channel = "email"
        timing = "within 24 hours of identifying them"
        expected_rate = "15-25%"
    elif "employee" in target_segment.lower() or "staff" in target_segment.lower():
        recommended_channel = "in_app"
        timing = "weekday morning (9-11am local time)"
        expected_rate = "40-60%"
    else:
        recommended_channel = "email"
        timing = "Tuesday-Thursday, 10am-2pm"
        expected_rate = "20-35%"

    return {
        "proposal_type": "distribute",
        "title": f"Send to {target_segment}",
        "description": f"Targeted distribution to {target_segment}: {goal}",
        "requires_confirmation": True,
        "params": {
            "survey_id":          survey_id,
            "target_segment":     target_segment,
            "channel":            recommended_channel,
            "recommended_timing": timing,
        },
        "estimated_response_rate": expected_rate,
        "estimated_time": "Set up in 3 minutes",
        "cta_label": "Set Up Distribution",
        "business_rationale": (
            f"Reaches {target_segment} via {recommended_channel} at an expected {expected_rate} "
            f"response rate, widening coverage to {goal}."
        )[:159],
    }


async def execute_propose_workflow(ctx: CrystalContext, params: dict) -> dict:
    """Propose an automation workflow based on response patterns.

    Reconciled (Xperiq Actions Wave 3) to emit the SAME modern `nodes`/`edges`
    engine graph shape as the dedicated NL builder's `POST /workflows/parse-nl`
    endpoint, via the shared `crystal.workflow_nl.parse_workflow_nl()` core —
    previously this returned an old flat `trigger`/`action_type: "notify"`/
    `action_config` shape that the graph engine (`workflowEngine.ts`) cannot
    execute. Both "AI creates a workflow" paths (in-chat proposal vs. the NL
    builder page) now produce engine-compatible output.

    NOTE (flagged for a frontend follow-up, out of this wave's scope):
    `CrystalPanel.tsx`'s `create_workflow` proposal handler still reads only
    `params.trigger` / `params.action_type` / `params.action_config` and calls
    `api.createWorkflow()` — it does not yet read `params.nodes`/`params.edges`
    or call `api.createGraphWorkflow()`. Until that handler is updated, an
    in-chat "create this workflow" confirm will create a workflow row with the
    new `trigger_type`/`nodes`/`edges` fields present in the POST body (the
    backend's `createWorkflowSchema` already accepts them) but the handler
    itself won't pass them through. This tool now emits the CORRECT shape so
    that frontend fix is a small, isolated change rather than a second
    reconciliation of the tool's output later.
    """
    from crystalos.crystal.workflow_nl import parse_workflow_nl, FALLBACK_REGISTRY

    survey_id         = params.get("survey_id") or ctx.survey_id
    trigger_condition = params.get("trigger_condition", "")
    desired_outcome   = params.get("desired_outcome", "")
    description = f"When {trigger_condition}, {desired_outcome}".strip() if trigger_condition or desired_outcome else ""

    if not description:
        return {
            "proposal_type": "workflow",
            "title": "Create response automation",
            "description": "Not enough detail to propose a workflow yet.",
            "requires_confirmation": True,
            "params": {"survey_id": survey_id, "trigger_type": None, "nodes": [], "edges": []},
            "cta_label": "Create Workflow",
            "business_rationale": "Describe both a trigger and desired outcome so Crystal can propose a working automation.",
        }

    result = await parse_workflow_nl(description, FALLBACK_REGISTRY)

    if not result.ok:
        return {
            "proposal_type": "workflow",
            "title": "Create response automation",
            "description": result.message or f"Trigger: {trigger_condition} → Action: {desired_outcome}",
            "requires_confirmation": True,
            "params": {"survey_id": survey_id, "trigger_type": None, "nodes": [], "edges": []},
            "cta_label": "Create Workflow",
            "business_rationale": (
                f"Automatically {desired_outcome or 'responds'} when {trigger_condition or 'the trigger fires'}, "
                f"cutting manual follow-up time and ensuring no at-risk response slips through."
            )[:159],
        }

    return {
        "proposal_type": "workflow",
        "title": result.name or "Create response automation",
        "description": result.description or f"Trigger: {trigger_condition} → Action: {desired_outcome}",
        "requires_confirmation": True,
        "params": {
            "survey_id":    survey_id,
            "name":         result.name,
            "description":  result.description,
            "trigger_type": result.trigger_type,
            "nodes":        result.nodes,
            "edges":        result.edges,
            "confidence":   result.confidence,
            "warnings":     result.warnings,
        },
        "estimated_time": "2 minutes to configure",
        "cta_label": "Create Workflow",
        "business_rationale": (
            f"Automatically {desired_outcome or 'responds'} when {trigger_condition or 'the trigger fires'}, "
            f"cutting manual follow-up time and ensuring no at-risk response slips through."
        )[:159],
    }


async def execute_propose_alert(ctx: CrystalContext, params: dict) -> dict:
    """Propose an alert rule when Crystal spots a metric/topic risk worth monitoring."""
    survey_id  = params.get("survey_id") or ctx.survey_id
    alert_type = params.get("alert_type") or "S-03"   # default: NPS Threshold Breach
    metric     = params.get("metric", "")
    condition  = params.get("condition", "")
    severity   = params.get("severity") or "warning"
    threshold  = params.get("threshold")
    name       = params.get("name") or (f"{metric} alert".strip() if metric else "Metric alert")

    # Resolve threshold_config in priority order so known alert types rarely ship empty:
    #   1. explicit threshold dict (non-empty)
    #   2. threshold parsed from the prose condition
    #   3. catalog default for the alert type
    if isinstance(threshold, dict) and threshold:
        threshold_config = threshold
    else:
        threshold_config = (
            _parse_threshold(condition)
            or _ALERT_TYPE_DEFAULT_THRESHOLDS.get(alert_type, {})
        )

    return {
        "proposal_type": "create_alert",
        "title": f"Set up alert: {name}"[:60],
        "description": f"Notify the team when {condition or metric or 'this metric crosses its threshold'}.",
        "requires_confirmation": True,
        "params": {
            "survey_id":        survey_id,
            "alert_type":       alert_type,
            "name":             name,
            "severity":         severity,
            "threshold_config": threshold_config,
        },
        "estimated_time": "1 minute to confirm",
        "cta_label": "Create Alert",
        "business_rationale": (
            f"Catches {metric or 'metric'} erosion within the alert window so the team "
            f"can intervene before detractors churn."
        )[:159],
    }


async def execute_list_relevant_templates(ctx: CrystalContext, params: dict) -> dict:
    """Search the template library for relevant survey templates."""
    search_query = params.get("search_query", "")
    survey_type  = params.get("survey_type", "any")

    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                if survey_type and survey_type != "any":
                    await cur.execute(
                        """SELECT id, name, survey_type_id, question_count FROM survey_templates
                           WHERE org_id = %s AND survey_type_id = %s ORDER BY usage_count DESC LIMIT 10""",
                        (ctx.org_id, survey_type),
                    )
                else:
                    await cur.execute(
                        """SELECT id, title, description, survey_type_id
                           FROM templates
                           WHERE org_id = %s AND (title ILIKE %s OR description ILIKE %s)
                           ORDER BY created_at DESC LIMIT 5""",
                        (ctx.org_id, f"%{search_query}%", f"%{search_query}%"),
                    )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]
                templates = [dict(zip(cols, r)) for r in rows]
                for t in templates:
                    t["id"] = str(t["id"])

        return {
            "templates": templates,
            "count": len(templates),
            "search_query": search_query,
        }
    except Exception as exc:
        logger.error("tool_list_templates_failed", error=str(exc))
        return {"error": str(exc), "templates": []}


# ── Analytical-skill tool executors ──────────────────────────────────────────
# Each fetches the raw data its skill needs, assembles the skill's documented input
# schema, runs the skill via the skill runtime, and returns the structured output.
# Mirrors the execute_recommend_next_actions → action-recommender pattern.

async def _run_skill(skill_name: str, skill_input: dict, ctx: CrystalContext, survey_id: str | None) -> dict:
    """Run a CrystalOS skill and return its output dict (or an {"error": ...} dict)."""
    try:
        from crystalos.lib.skill_registry import get_registry as _get_reg
        reg = _get_reg()
        if not reg.is_initialized() or not reg.get_skill_meta(skill_name):
            return {"error": f"{skill_name} skill not available (skill runtime not initialized)"}
        result = await reg.execute(
            skill_name,
            skill_input,
            {"org_id": ctx.org_id, "survey_id": survey_id},
        )
        output = result.get("output")
        if not output:
            return {"error": f"{skill_name} produced no output"}
        return output
    except Exception as exc:
        logger.error("crystal_skill_bridge_failed", skill=skill_name, error=str(exc))
        return {"error": str(exc)}


async def _fetch_analysis_context(ctx: CrystalContext, survey_id: str) -> dict:
    """Fetch the shared survey context (title, topics, metrics, insights, verbatims)
    used to build inputs for the analytical skills. One round-trip, reused by all wrappers.
    """
    out: dict = {
        "title": "", "survey_type": "custom", "response_count": 0,
        "topics": [], "metrics": {}, "insights": [], "verbatims": [],
    }
    async with db._pool_conn().connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT title, survey_type_id,
                          (SELECT COUNT(*)::int FROM responses r WHERE r.survey_id = surveys.id) AS rc
                   FROM surveys WHERE id = %s AND org_id = %s AND deleted_at IS NULL""",
                (survey_id, ctx.org_id),
            )
            row = await cur.fetchone()
            if row:
                out["title"] = row[0] or ""
                out["survey_type"] = (row[1] or "custom")
                out["response_count"] = row[2] or 0

            await cur.execute(
                """SELECT name, sentiment_score, volume, urgency_score, trending, nps_avg, effort_score
                   FROM survey_topics
                   WHERE survey_id = %s AND org_id = %s AND time_window = 'all_time'
                   ORDER BY volume DESC NULLS LAST LIMIT 15""",
                (survey_id, ctx.org_id),
            )
            cols = [d[0] for d in cur.description]
            topics = [dict(zip(cols, r)) for r in await cur.fetchall()]
            total_vol = max(1, sum(int(t.get("volume") or 0) for t in topics))
            for t in topics:
                for k in ("sentiment_score", "urgency_score", "nps_avg", "effort_score"):
                    if t.get(k) is not None:
                        t[k] = float(t[k])
                t["volume"] = int(t.get("volume") or 0)
                t["volume_pct"] = round(t["volume"] / total_vol, 4)
            out["topics"] = topics

            await cur.execute(
                """SELECT nps, csat, effort_score, response_count
                   FROM survey_metric_snapshots WHERE survey_id = %s AND org_id = %s
                   ORDER BY captured_at DESC LIMIT 1""",
                (survey_id, ctx.org_id),
            )
            snap = await cur.fetchone()
            if snap:
                out["metrics"] = {
                    "nps":  {"score": float(snap[0]) if snap[0] is not None else None, "n": snap[3] or 0},
                    "csat": {"score": float(snap[1]) if snap[1] is not None else None, "n": snap[3] or 0},
                    "ces":  {"score": float(snap[2]) if snap[2] is not None else None, "n": snap[3] or 0},
                }

            await cur.execute(
                """SELECT layer, headline, narrative, trust_score FROM insights
                   WHERE survey_id = %s AND org_id = %s AND superseded_at IS NULL
                   ORDER BY trust_score DESC NULLS LAST LIMIT 10""",
                (survey_id, ctx.org_id),
            )
            cols = [d[0] for d in cur.description]
            out["insights"] = [dict(zip(cols, r)) for r in await cur.fetchall()]

            await cur.execute(
                """SELECT r.answers FROM responses r
                   WHERE r.survey_id = %s AND r.org_id = %s
                   ORDER BY r.submitted_at DESC LIMIT 25""",
                (survey_id, ctx.org_id),
            )
            verbatims: list[str] = []
            for vr in await cur.fetchall():
                answers = vr[0]
                if isinstance(answers, str):
                    try: answers = json.loads(answers)
                    except Exception: answers = []
                for a in (answers or []):
                    val = a.get("value") if isinstance(a, dict) else None
                    if isinstance(val, str) and len(val.strip()) > 12:
                        verbatims.append(val.strip()[:300])
            out["verbatims"] = verbatims[:15]
    return out


def _topics_for_skill(topics: list[dict]) -> list[dict]:
    """Map DB topic rows to the {label, sentiment_score, volume, volume_pct, trending} shape."""
    return [
        {
            "label":           t.get("name", ""),
            "sentiment_score": t.get("sentiment_score", 0.0),
            "volume":          t.get("volume", 0),
            "volume_pct":      t.get("volume_pct", 0.0),
            "trending":        t.get("trending"),
            "urgency_score":   t.get("urgency_score", 0.5),
            "sample_verbatims": [],
        }
        for t in topics
    ]


async def execute_summarize_themes(ctx: CrystalContext, params: dict) -> dict:
    """Summarize/explore qualitative feedback via the data-explorer skill."""
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        if not survey_id:
            return {"error": "survey_id required"}
        actx = await _fetch_analysis_context(ctx, survey_id)
        skill_input = {
            "question":        params.get("question", "What are the key themes and takeaways?"),
            "survey_id":       survey_id,
            "survey_type":     actx["survey_type"],
            "topics":          _topics_for_skill(actx["topics"]),
            "verbatim_samples": actx["verbatims"],
            "metrics":         actx["metrics"],
            "prior_period_topics": [],
        }
        return await _run_skill("data-explorer", skill_input, ctx, survey_id)
    except Exception as exc:
        logger.error("tool_summarize_themes_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_analyze_trends_over_time(ctx: CrystalContext, params: dict) -> dict:
    """Analyze metric/theme trajectories via the trend-analyst skill."""
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        if not survey_id:
            return {"error": "survey_id required"}
        metric = params.get("metric", "nps")
        if metric in ("all", "sentiment"):
            metric = "nps"
        days = int(params.get("days", 90))

        history = await execute_get_metric_history(ctx, {"survey_id": survey_id, "days": days})
        anomalies = await execute_get_anomaly_events(ctx, {"survey_id": survey_id, "days": days})

        series = []
        for h in (history.get("history") or []):
            value = h.get(f"{metric}_score")
            if value is not None:
                series.append({"period": h.get("captured_at"), "value": value, "n": h.get("response_count") or 0})

        skill_input = {
            "survey_id":  survey_id,
            "metric":     metric.upper() if metric in ("nps", "csat", "ces") else metric,
            "metric_series": series,
            "topic_trends": [],
            "changepoints": [],
            "anomaly_events": [
                {"period": e.get("captured_at") or e.get("period"), "description": e.get("description") or e.get("metric", "")}
                for e in (anomalies.get("events") or [])
            ],
            "comparison_window_days": days,
        }
        return await _run_skill("trend-analyst", skill_input, ctx, survey_id)
    except Exception as exc:
        logger.error("tool_analyze_trends_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_analyze_segments(ctx: CrystalContext, params: dict) -> dict:
    """Analyze cross-segment differences via the segment-analyst skill."""
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        if not survey_id:
            return {"error": "survey_id required"}
        metric = params.get("metric", "sentiment")
        breakdown = await execute_get_segment_breakdown(ctx, {
            "survey_id": survey_id,
            "segment_question_id": params.get("segment_question_id"),
            "segment_question_text": params.get("segment_question_text"),
            "metric": metric,
        })
        if "error" in breakdown:
            return breakdown  # surfaces available_segments so the loop can pick one

        segs = breakdown.get("segments") or []
        total_n = max(1, sum(s.get("count", 0) for s in segs))
        score_key = "nps_avg" if metric == "nps" else "avg_sentiment_score"
        scored = [s for s in segs if s.get(score_key) is not None]
        overall_score = round(sum(s[score_key] * s["count"] for s in scored) / max(1, sum(s["count"] for s in scored)), 2) if scored else 0.0

        skill_input = {
            "survey_id": survey_id,
            "metric":    "NPS" if metric == "nps" else "sentiment",
            "overall":   {"score": overall_score, "n": total_n},
            "dimension": params.get("segment_question_text") or params.get("segment_question_id") or "segment",
            "segment_breakdowns": [
                {
                    "segment": s.get("segment", "unknown"),
                    "score":   s.get(score_key) or 0.0,
                    "n":       s.get("count", 0),
                    "share_of_responses": round(s.get("count", 0) / total_n, 4),
                    "top_topics": [],
                    "sample_verbatims": [],
                }
                for s in segs
            ],
        }
        return await _run_skill("segment-analyst", skill_input, ctx, survey_id)
    except Exception as exc:
        logger.error("tool_analyze_segments_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_analyze_key_drivers(ctx: CrystalContext, params: dict) -> dict:
    """Key driver analysis via the driver-analyst skill."""
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        if not survey_id:
            return {"error": "survey_id required"}
        metric = params.get("metric", "nps")
        da = await execute_get_driver_analysis(ctx, {"survey_id": survey_id, "metric": metric if metric in ("nps", "csat") else "nps"})
        actx = await _fetch_analysis_context(ctx, survey_id)
        total_vol = max(1, sum(int(d.get("volume") or 0) for d in (da.get("drivers") or [])))

        drivers = []
        for d in (da.get("drivers") or []):
            # driver_impact is sentiment scaled to -100..100; importance ≈ |impact|, performance ≈ sentiment sign
            impact = float(d.get("driver_impact") or 0)
            drivers.append({
                "label":       d.get("topic", ""),
                "importance":  round(min(1.0, abs(impact) / 100.0), 3),
                "performance": round(impact / 100.0, 3),
                "volume_pct":  round(int(d.get("volume") or 0) / total_vol, 4),
                "sample_verbatims": [],
            })

        outcome = (actx["metrics"].get(metric) or actx["metrics"].get("nps") or {})
        skill_input = {
            "survey_id":      survey_id,
            "outcome_metric": metric.upper() if metric in ("nps", "csat", "ces", "enps") else "NPS",
            "outcome_score":  outcome.get("score") or 0.0,
            "drivers":        drivers,
            "method":         "sentiment_volume_impact",
        }
        return await _run_skill("driver-analyst", skill_input, ctx, survey_id)
    except Exception as exc:
        logger.error("tool_analyze_drivers_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_proactive_insights(ctx: CrystalContext, params: dict) -> dict:
    """Surface unprompted insight cards via the proactive-insights skill."""
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        if not survey_id:
            return {"error": "survey_id required"}
        actx = await _fetch_analysis_context(ctx, survey_id)
        anomalies = await execute_get_anomaly_events(ctx, {"survey_id": survey_id, "days": 30})

        skill_input = {
            "survey_id":   survey_id,
            "survey_type": actx["survey_type"],
            "trigger":     "manual",
            "anomaly_events": [
                {
                    "period": e.get("captured_at") or e.get("period"),
                    "metric": e.get("metric", ""),
                    "description": e.get("description") or "",
                    "severity": float(e.get("severity") or 0.5),
                }
                for e in (anomalies.get("events") or [])
            ],
            "trend_signals": [],
            "driver_shifts": [],
            "segment_gaps": [],
            "recently_notified": [],
            "thresholds": {"min_severity": 0.3, "max_cards": 3},
        }
        return await _run_skill("proactive-insights", skill_input, ctx, survey_id)
    except Exception as exc:
        logger.error("tool_proactive_insights_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_generate_report(ctx: CrystalContext, params: dict) -> dict:
    """Generate a full export-ready report via the report-composer skill.

    Orchestrates the lighter analytical skills in parallel to build section_inputs,
    tolerating failures (a failed/empty section is simply omitted by report-composer).
    """
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        if not survey_id:
            return {"error": "survey_id required"}
        actx = await _fetch_analysis_context(ctx, survey_id)

        themes, trends, drivers, benchmark = await asyncio.gather(
            execute_summarize_themes(ctx, {"survey_id": survey_id}),
            execute_analyze_trends_over_time(ctx, {"survey_id": survey_id}),
            execute_analyze_key_drivers(ctx, {"survey_id": survey_id}),
            execute_get_benchmark_comparison(ctx, {"survey_id": survey_id}),
            return_exceptions=True,
        )

        def _ok(x):
            return x if isinstance(x, dict) and "error" not in x else None

        m = actx["metrics"]
        section_inputs = {
            "narrative": None,
            "trends":    _ok(trends),
            "drivers":   _ok(drivers),
            "segments":  None,
            "themes":    _ok(themes),
            "benchmark": _ok(benchmark),
            "actions":   None,
        }
        skill_input = {
            "survey_context": {
                "survey_id":      survey_id,
                "survey_title":   actx["title"],
                "survey_type":    actx["survey_type"],
                "response_count": actx["response_count"],
                "headline_metrics": {
                    "nps":  (m.get("nps")  or {}).get("score"),
                    "csat": (m.get("csat") or {}).get("score"),
                    "ces":  (m.get("ces")  or {}).get("score"),
                    "enps": None,
                },
            },
            "report_options": {
                "audience": params.get("audience", "executive"),
                "length":   params.get("length", "standard"),
                "sections_requested": ["overview", "trends", "drivers", "themes", "benchmark"],
            },
            "section_inputs": section_inputs,
        }
        return await _run_skill("report-composer", skill_input, ctx, survey_id)
    except Exception as exc:
        logger.error("tool_generate_report_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


# ── Group tool executors (cross-survey intelligence) ─────────────────────────

async def execute_get_group_surveys(ctx: CrystalContext, params: dict) -> dict:
    """List all surveys belonging to one or more tag groups."""
    try:
        tag_ids = params.get("tag_ids", [])
        if not tag_ids:
            return {"error": "tag_ids required"}

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT s.id, s.title, s.status, s.survey_type_id, s.created_at,
                              COUNT(r.id)::int AS response_count
                       FROM surveys s
                       LEFT JOIN responses r ON r.survey_id = s.id
                       WHERE s.id IN (
                         SELECT survey_id FROM survey_tag_mappings
                         WHERE tag_id = ANY(%s::uuid[]) AND org_id = %s
                       ) AND s.org_id = %s AND s.deleted_at IS NULL
                       GROUP BY s.id
                       ORDER BY s.created_at DESC""",
                    (tag_ids, ctx.org_id, ctx.org_id),
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]

        surveys = []
        for row in rows:
            s = dict(zip(cols, row))
            s["id"] = str(s["id"])
            if s.get("created_at"):
                s["created_at"] = str(s["created_at"])
            if s.get("survey_type_id"):
                s["survey_type_id"] = str(s["survey_type_id"])
            surveys.append(s)

        return {"surveys": surveys, "count": len(surveys)}
    except Exception as exc:
        logger.error("tool_get_group_surveys_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_group_metrics(ctx: CrystalContext, params: dict) -> dict:
    """Get aggregated NPS/CSAT/CES metrics across all surveys in a group."""
    try:
        tag_ids = params.get("tag_ids", [])
        if not tag_ids:
            return {"error": "tag_ids required"}

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                # Get survey IDs in the group
                await cur.execute(
                    """SELECT s.id, s.title,
                              (SELECT COUNT(*)::int FROM responses r WHERE r.survey_id = s.id) AS response_count
                       FROM surveys s
                       WHERE s.id IN (
                         SELECT survey_id FROM survey_tag_mappings
                         WHERE tag_id = ANY(%s::uuid[]) AND org_id = %s
                       ) AND s.org_id = %s AND s.deleted_at IS NULL""",
                    (tag_ids, ctx.org_id, ctx.org_id),
                )
                survey_rows = await cur.fetchall()

                per_survey = []
                total_nps_weighted = 0.0
                total_csat_weighted = 0.0
                total_nps_n = 0
                total_csat_n = 0
                total_response_count = 0

                for sr in survey_rows:
                    sid, stitle, rcount = str(sr[0]), sr[1], sr[2] or 0
                    total_response_count += rcount

                    await cur.execute(
                        """SELECT nps, csat FROM survey_metric_snapshots
                           WHERE survey_id = %s AND org_id = %s
                           ORDER BY captured_at DESC LIMIT 1""",
                        (sid, ctx.org_id),
                    )
                    snap = await cur.fetchone()
                    nps_val = float(snap[0]) if snap and snap[0] is not None else None
                    csat_val = float(snap[1]) if snap and snap[1] is not None else None

                    if nps_val is not None and rcount > 0:
                        total_nps_weighted += nps_val * rcount
                        total_nps_n += rcount
                    if csat_val is not None and rcount > 0:
                        total_csat_weighted += csat_val * rcount
                        total_csat_n += rcount

                    per_survey.append({
                        "survey_id": sid,
                        "title": stitle,
                        "nps": nps_val,
                        "csat": csat_val,
                        "response_count": rcount,
                    })

        agg_nps = round(total_nps_weighted / total_nps_n, 1) if total_nps_n > 0 else None
        agg_csat = round(total_csat_weighted / total_csat_n, 2) if total_csat_n > 0 else None

        return {
            "aggregate": {
                "nps": agg_nps,
                "csat": agg_csat,
                "response_count": total_response_count,
                "survey_count": len(per_survey),
            },
            "per_survey": per_survey,
        }
    except Exception as exc:
        logger.error("tool_get_group_metrics_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_group_topics(ctx: CrystalContext, params: dict) -> dict:
    """Get cross-survey topic landscape for a group."""
    try:
        tag_ids = params.get("tag_ids", [])
        limit = min(int(params.get("limit", 30)), 100)
        if not tag_ids:
            return {"error": "tag_ids required"}

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT t.name, t.survey_id, s.title AS survey_title,
                              t.volume, t.sentiment_score, t.dominant_emotion, t.trending
                       FROM survey_topics t
                       JOIN surveys s ON s.id = t.survey_id
                       WHERE t.survey_id IN (
                         SELECT survey_id FROM survey_tag_mappings
                         WHERE tag_id = ANY(%s::uuid[]) AND org_id = %s
                       ) AND t.org_id = %s AND t.time_window = 'all_time'
                       ORDER BY t.volume DESC
                       LIMIT %s""",
                    (tag_ids, ctx.org_id, ctx.org_id, limit),
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]

        # Group by topic name across surveys
        topic_map: dict[str, dict] = {}
        for row in rows:
            r = dict(zip(cols, row))
            name = r["name"]
            if name not in topic_map:
                topic_map[name] = {
                    "name": name,
                    "total_volume": 0,
                    "surveys": [],
                    "sentiment_scores": [],
                    "dominant_emotion": r.get("dominant_emotion"),
                }
            topic_map[name]["total_volume"] += int(r.get("volume") or 0)
            stitle = r.get("survey_title")
            if stitle and stitle not in topic_map[name]["surveys"]:
                topic_map[name]["surveys"].append(stitle)
            if r.get("sentiment_score") is not None:
                topic_map[name]["sentiment_scores"].append(float(r["sentiment_score"]))

        topics = []
        for name, t in topic_map.items():
            scores = t.pop("sentiment_scores")
            t["avg_sentiment"] = round(sum(scores) / len(scores), 3) if scores else None
            topics.append(t)

        topics.sort(key=lambda x: x["total_volume"], reverse=True)

        return {"topics": topics, "unique_count": len(topics)}
    except Exception as exc:
        logger.error("tool_get_group_topics_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_analyze_group_coverage(ctx: CrystalContext, params: dict) -> dict:
    """Analyze coverage dimensions of a survey group."""
    try:
        tag_ids = params.get("tag_ids", [])
        if not tag_ids:
            return {"error": "tag_ids required"}

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT s.id, s.title, s.survey_type_id, s.created_at,
                              (SELECT COUNT(*)::int FROM responses r WHERE r.survey_id = s.id) AS response_count,
                              s.questions
                       FROM surveys s
                       WHERE s.id IN (
                         SELECT survey_id FROM survey_tag_mappings
                         WHERE tag_id = ANY(%s::uuid[]) AND org_id = %s
                       ) AND s.org_id = %s AND s.deleted_at IS NULL
                       ORDER BY s.created_at ASC""",
                    (tag_ids, ctx.org_id, ctx.org_id),
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]

        survey_list = []
        year_months: set[tuple] = set()
        survey_types: set[str] = set()
        has_open_text = False

        for row in rows:
            s = dict(zip(cols, row))
            sid = str(s["id"])
            rcount = s.get("response_count") or 0
            stype = str(s.get("survey_type_id") or "custom")
            created_at = s.get("created_at")

            if created_at:
                try:
                    year_months.add((created_at.year, created_at.month))
                except AttributeError:
                    pass

            survey_types.add(stype)

            # Check for open-text questions
            questions = s.get("questions") or []
            if isinstance(questions, str):
                try:
                    import json as _json
                    questions = _json.loads(questions)
                except Exception:
                    questions = []
            open_text_types = {"open_text", "short_text", "text", "textarea"}
            if any(q.get("type") in open_text_types for q in questions if isinstance(q, dict)):
                has_open_text = True

            survey_list.append({
                "survey_id": sid,
                "title": s.get("title", ""),
                "survey_type_id": stype,
                "response_count": rcount,
                "created_at": str(created_at) if created_at else None,
            })

        # Detect cadence: if we have >= 2 surveys, compute average gap
        sorted_ym = sorted(year_months)
        cadence = "unknown"
        if len(sorted_ym) >= 2:
            # Approximate in months
            gaps = []
            for i in range(1, len(sorted_ym)):
                a, b = sorted_ym[i-1], sorted_ym[i]
                gap = (b[0] - a[0]) * 12 + (b[1] - a[1])
                gaps.append(gap)
            avg_gap = sum(gaps) / len(gaps)
            if avg_gap <= 1.5:
                cadence = "monthly"
            elif avg_gap <= 3.5:
                cadence = "quarterly"
            elif avg_gap <= 6.5:
                cadence = "biannual"
            else:
                cadence = "annual_or_less"

        return {
            "time_coverage": {
                "periods": [{"year": y, "month": m} for y, m in sorted_ym],
                "cadence": cadence,
                "period_count": len(sorted_ym),
            },
            "survey_types": list(survey_types),
            "response_coverage": survey_list,
            "has_open_text": has_open_text,
            "survey_count": len(survey_list),
        }
    except Exception as exc:
        logger.error("tool_analyze_group_coverage_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_detect_data_gaps(ctx: CrystalContext, params: dict) -> dict:
    """Detect data gaps in a survey group (temporal, survey type, response volume, metric)."""
    try:
        tag_ids = params.get("tag_ids", [])
        if not tag_ids:
            return {"error": "tag_ids required"}

        # 1. Get coverage via analyze_group_coverage
        coverage = await execute_analyze_group_coverage(ctx, params)
        if "error" in coverage:
            return coverage

        gaps: list[dict] = []

        time_cov = coverage.get("time_coverage", {})
        periods = time_cov.get("periods", [])
        cadence = time_cov.get("cadence", "unknown")
        survey_types = coverage.get("survey_types", [])
        response_coverage = coverage.get("response_coverage", [])

        # 2. Temporal gap detection
        if len(periods) >= 2 and cadence != "unknown":
            period_set = {(p["year"], p["month"]) for p in periods}
            if cadence == "monthly":
                step = 1
            elif cadence == "quarterly":
                step = 3
            elif cadence == "biannual":
                step = 6
            else:
                step = 12

            if periods:
                first_y, first_m = periods[0]["year"], periods[0]["month"]
                last_y, last_m = periods[-1]["year"], periods[-1]["month"]

                cur_y, cur_m = first_y, first_m
                while (cur_y, cur_m) <= (last_y, last_m):
                    if (cur_y, cur_m) not in period_set:
                        gaps.append({
                            "type": "temporal",
                            "description": f"No survey data for {cur_y}-{cur_m:02d}",
                            "severity": "moderate",
                            "missing_value": f"{cur_y}-{cur_m:02d}",
                            "suggested_survey_type": survey_types[0] if survey_types else "custom",
                        })
                    cur_m += step
                    if cur_m > 12:
                        cur_y += cur_m // 13
                        cur_m = cur_m % 12 or 12

        # 3. Response volume gaps
        for s in response_coverage:
            if s.get("response_count", 0) < 10:
                gaps.append({
                    "type": "survey_type",
                    "description": f"Survey '{s.get('title', s['survey_id'])}' has insufficient data ({s['response_count']} responses)",
                    "severity": "critical" if s["response_count"] == 0 else "moderate",
                    "missing_value": f"min_responses_{s['survey_id'][:8]}",
                    "suggested_survey_type": s.get("survey_type_id", "custom"),
                })

        # 4. Metric dimension gaps — check if NPS/CSAT/CES are all present
        metrics_result = await execute_get_group_metrics(ctx, params)
        if "aggregate" in metrics_result:
            agg = metrics_result["aggregate"]
            if agg.get("nps") is None:
                gaps.append({
                    "type": "metric",
                    "description": "No NPS (loyalty) data across any survey in this group",
                    "severity": "critical",
                    "missing_value": "nps",
                    "suggested_survey_type": "nps",
                })
            if agg.get("csat") is None:
                gaps.append({
                    "type": "metric",
                    "description": "No CSAT (satisfaction) data across any survey in this group",
                    "severity": "moderate",
                    "missing_value": "csat",
                    "suggested_survey_type": "csat",
                })

        # 5. Coverage score: 1.0 = no gaps, decreasing by gap severity
        severity_weights = {"critical": 0.3, "moderate": 0.1, "low": 0.03}
        penalty = sum(severity_weights.get(g["severity"], 0.05) for g in gaps)
        coverage_score = max(0.0, round(1.0 - penalty, 2))

        total = len(response_coverage)
        summary = (
            f"Group has {total} survey(s) with {len(gaps)} gap(s) detected. "
            f"Coverage score: {coverage_score:.0%}. "
            + (f"Critical gaps: {sum(1 for g in gaps if g['severity'] == 'critical')}." if any(g['severity'] == 'critical' for g in gaps) else "No critical gaps found.")
        )

        return {
            "gaps": gaps,
            "coverage_score": coverage_score,
            "summary": summary,
        }
    except Exception as exc:
        logger.error("tool_detect_data_gaps_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_suggest_new_survey(ctx: CrystalContext, params: dict) -> dict:
    """Propose a new survey to fill a detected gap in a group."""
    try:
        tag_ids = params.get("tag_ids", [])
        gap_description = params.get("gap_description", "")
        gap_type = params.get("gap_type", "custom")

        if not gap_description:
            return {"error": "gap_description required"}

        # Map gap type to survey type and question hints
        type_map = {
            "temporal": {
                "survey_type": "pulse",
                "title_prefix": "Periodic Pulse",
                "questions_hint": "How satisfied are you overall? What's working well? What needs improvement?",
                "estimated_responses_needed": 50,
            },
            "survey_type": {
                "survey_type": "nps",
                "title_prefix": "Loyalty Benchmark",
                "questions_hint": "How likely are you to recommend us? What is the primary reason for your score?",
                "estimated_responses_needed": 100,
            },
            "segment": {
                "survey_type": "csat",
                "title_prefix": "Segment Experience",
                "questions_hint": "How satisfied are you with your experience? What could we do better for your segment?",
                "estimated_responses_needed": 75,
            },
            "metric": {
                "survey_type": "ces",
                "title_prefix": "Effort Measurement",
                "questions_hint": "How easy was it to accomplish your goal? What made it harder than expected?",
                "estimated_responses_needed": 50,
            },
            "topic": {
                "survey_type": "custom",
                "title_prefix": "Topic Deep Dive",
                "questions_hint": "How would you rate your experience with this area? What specific improvements would help most?",
                "estimated_responses_needed": 40,
            },
        }

        config = type_map.get(gap_type, type_map["topic"])
        title = f"{config['title_prefix']}: {gap_description[:60]}"

        return {
            "proposal": {
                "title": title,
                "survey_type": config["survey_type"],
                "description": f"New survey to address: {gap_description}",
                "suggested_questions_hint": config["questions_hint"],
                "pre_filled_tags": tag_ids,
                "estimated_responses_needed": config["estimated_responses_needed"],
            }
        }
    except Exception as exc:
        logger.error("tool_suggest_new_survey_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_contact_identity(ctx: CrystalContext, params: dict, **kwargs) -> dict:
    """Fetch contact record linked to a response (requires data:pii permission)."""
    try:
        if "data:pii" not in ctx.effective_perms:
            return {"error": "data:pii permission required", "masked": True}
        response_id = params.get("response_id")
        if not response_id:
            return {"error": "response_id required"}
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT c.id, c.name, c.email, c.account_id, c.account_name,
                              c.segment_attrs, c.consent_given
                       FROM contacts c
                       JOIN responses r ON r.contact_id = c.id
                       WHERE r.id = %s AND c.org_id = %s AND c.anonymized_at IS NULL""",
                    (response_id, ctx.org_id),
                )
                row = await cur.fetchone()
                if not row:
                    return {"contact": None}
                cols = [d[0] for d in cur.description]
                contact = dict(zip(cols, row))
                contact["id"] = str(contact["id"]) if contact.get("id") else None
        return {"contact": contact}
    except Exception as exc:
        logger.error("tool_get_contact_identity_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_propose_assign_owner(ctx: CrystalContext, params: dict, **kwargs) -> dict:
    """Propose assigning this case/contact to an owner via ownership routing."""
    # First resolve the owner via the routing rule
    route_result = await execute_get_ownership_route(ctx, params)
    if not route_result.get("matched"):
        return {
            "proposal_type": "assign_owner",
            "title": "Assign Owner",
            "description": "No routing rule matched. Manual assignment required.",
            "params": params,
            "requires_confirmation": True,
            "matched": False,
        }
    return {
        "proposal_type": "assign_owner",
        "title": f"Assign to {route_result.get('owner_label', 'Owner')}",
        "description": f"Route this case to {route_result.get('owner_label')} based on the '{route_result.get('rule_match_value', 'matching')}' routing rule.",
        "params": {
            "owner_user_id": route_result.get("owner_user_id"),
            "owner_label": route_result.get("owner_label"),
            "rule_id": route_result.get("rule_id"),
            **params,
        },
        "requires_confirmation": True,
        "matched": True,
    }


async def execute_get_ownership_route(ctx: CrystalContext, params: dict, **kwargs) -> dict:
    """Resolve dimension+value → owner identity (no PII, safe for all roles)."""
    try:
        dimension = params.get("dimension", "")
        value = params.get("match_value", "")

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT id, dimension, match_type, match_value, owner_user_id,
                              owner_label, role_label, escalation_user_id, priority
                       FROM ownership_routes
                       WHERE org_id = %s AND (dimension = %s OR dimension = '')
                       ORDER BY priority ASC""",
                    (ctx.org_id, dimension),
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]

        for row in rows:
            route = dict(zip(cols, row))
            match_type = route.get("match_type", "exact")
            mv = route.get("match_value", "") or ""

            matched = False
            if match_type == "exact":
                matched = mv == value
            elif match_type == "prefix":
                matched = value.startswith(mv)
            elif match_type == "contains":
                matched = mv in value
            elif match_type == "regex":
                try:
                    matched = bool(re.search(mv, value, re.IGNORECASE))
                except re.error:
                    matched = False

            if matched:
                return {
                    "matched": True,
                    "owner_user_id": route.get("owner_user_id"),
                    "owner_label": route.get("owner_label"),
                    "role_label": route.get("role_label"),
                    "escalation_user_id": route.get("escalation_user_id"),
                }

        return {
            "matched": False,
            "owner_user_id": None,
            "owner_label": None,
            "role_label": None,
            "escalation_user_id": None,
        }
    except Exception as exc:
        logger.error("tool_get_ownership_route_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_ontology_context(ctx: CrystalContext, params: dict, **kwargs) -> dict:
    """Get ontology nodes and edges relevant to a given topic/signal/concept."""
    try:
        concept = params.get("concept")
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT n.id, n.label, n.category, n.description,
                              n.x_data_ref, n.x_data_range, n.o_data_ref
                       FROM ontology_nodes n
                       WHERE (n.org_id = '' OR n.org_id = %s)
                         AND (%s::text IS NULL
                              OR n.label ILIKE '%%' || %s || '%%'
                              OR %s = ANY(n.synonyms))""",
                    (ctx.org_id, concept, concept, concept),
                )
                node_rows = await cur.fetchall()
                node_cols = [d[0] for d in cur.description]
                nodes = [dict(zip(node_cols, r)) for r in node_rows]
                for n in nodes:
                    n["id"] = str(n["id"]) if n.get("id") else None

                node_ids = [n["id"] for n in nodes if n.get("id")]
                edges: list[dict] = []
                mappings: list[dict] = []

                if node_ids:
                    await cur.execute(
                        """SELECT e.id, e.source_node_id, e.target_node_id,
                                  e.relationship_type, n.label AS target_label
                           FROM ontology_edges e
                           JOIN ontology_nodes n ON n.id = e.target_node_id
                           WHERE e.source_node_id = ANY(%s::uuid[])""",
                        (node_ids,),
                    )
                    edge_rows = await cur.fetchall()
                    edge_cols = [d[0] for d in cur.description]
                    edges = [dict(zip(edge_cols, r)) for r in edge_rows]
                    for e in edges:
                        e["id"] = str(e["id"]) if e.get("id") else None

                    await cur.execute(
                        """SELECT m.id, m.node_id, m.x_data_type, m.x_data_value_range,
                                  m.o_data_field, m.mapping_label
                           FROM ontology_mappings m
                           WHERE m.node_id = ANY(%s::uuid[])""",
                        (node_ids,),
                    )
                    map_rows = await cur.fetchall()
                    map_cols = [d[0] for d in cur.description]
                    mappings = [dict(zip(map_cols, r)) for r in map_rows]
                    for m in mappings:
                        m["id"] = str(m["id"]) if m.get("id") else None

        return {"nodes": nodes, "edges": edges, "mappings": mappings}
    except Exception as exc:
        logger.error("tool_get_ontology_context_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_xo_context(ctx: CrystalContext, params: dict, **kwargs) -> dict:
    """Cross X-data signals with O-data ontology mappings to identify convergence risks."""
    try:
        segment = params.get("segment")
        account_id = params.get("account_id")
        survey_id = params.get("survey_id") or ctx.survey_id

        if not segment and not account_id:
            return {"error": "segment or account_id required"}

        x_signals: list[dict] = []
        o_mappings: list[dict] = []
        convergence_risks: list[dict] = []

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                # Fetch X-data: NPS + sentiment for segment/account
                conditions = ["r.org_id = %s"]
                args: list = [ctx.org_id]
                if survey_id:
                    conditions.append("r.survey_id = %s")
                    args.append(survey_id)
                if account_id:
                    conditions.append("c.account_id = %s")
                    args.append(account_id)
                    await cur.execute(
                        f"""SELECT r.nps_score, r.ai_sentiment_score, r.ai_sentiment,
                                   t.name AS topic_name, t.sentiment_score AS topic_sentiment
                            FROM responses r
                            LEFT JOIN contacts c ON c.id = r.contact_id
                            LEFT JOIN survey_topics t ON t.survey_id = r.survey_id
                              AND t.org_id = r.org_id AND t.time_window = 'all_time'
                            WHERE {' AND '.join(conditions)}
                            ORDER BY r.submitted_at DESC LIMIT 50""",
                        args,
                    )
                else:
                    await cur.execute(
                        f"""SELECT r.nps_score, r.ai_sentiment_score, r.ai_sentiment,
                                   t.name AS topic_name, t.sentiment_score AS topic_sentiment
                            FROM responses r
                            LEFT JOIN survey_topics t ON t.survey_id = r.survey_id
                              AND t.org_id = r.org_id AND t.time_window = 'all_time'
                            WHERE {' AND '.join(conditions)}
                            ORDER BY r.submitted_at DESC LIMIT 50""",
                        args,
                    )
                x_rows = await cur.fetchall()
                x_cols = [d[0] for d in cur.description]
                x_data = [dict(zip(x_cols, r)) for r in x_rows]

                # Compute aggregate X signal
                nps_scores = [float(r["nps_score"]) for r in x_data if r.get("nps_score") is not None]
                sentiment_scores = [float(r["ai_sentiment_score"]) for r in x_data if r.get("ai_sentiment_score") is not None]
                avg_nps = round(sum(nps_scores) / len(nps_scores), 1) if nps_scores else None
                avg_sentiment = round(sum(sentiment_scores) / len(sentiment_scores), 3) if sentiment_scores else None

                if avg_nps is not None or avg_sentiment is not None:
                    x_signals.append({
                        "entity": account_id or segment,
                        "avg_nps": avg_nps,
                        "avg_sentiment": avg_sentiment,
                        "n": len(x_data),
                    })

                # Fetch O-data ontology mappings for NPS risk range
                await cur.execute(
                    """SELECT m.id, m.node_id, m.x_data_type, m.x_data_value_range,
                              m.o_data_field, m.mapping_label, n.label AS node_label,
                              n.category AS node_category
                       FROM ontology_mappings m
                       JOIN ontology_nodes n ON n.id = m.node_id
                       WHERE (n.org_id = '' OR n.org_id = %s)
                         AND m.x_data_type IN ('nps', 'sentiment')""",
                    (ctx.org_id,),
                )
                map_rows = await cur.fetchall()
                map_cols = [d[0] for d in cur.description]
                o_mappings = [dict(zip(map_cols, r)) for r in map_rows]
                for m in o_mappings:
                    m["id"] = str(m["id"]) if m.get("id") else None

        # Compute convergence risks: where X signal aligns with O mapping risk threshold
        for signal in x_signals:
            for mapping in o_mappings:
                x_range = mapping.get("x_data_value_range") or {}
                score_field = "avg_nps" if mapping.get("x_data_type") == "nps" else "avg_sentiment"
                score_val = signal.get(score_field)
                if score_val is None:
                    continue
                threshold_below = x_range.get("below")
                threshold_above = x_range.get("above")
                convergence = False
                convergence_score = 0.0
                if threshold_below is not None and score_val < float(threshold_below):
                    convergence = True
                    convergence_score = round(1.0 - (score_val / float(threshold_below)), 2)
                elif threshold_above is not None and score_val > float(threshold_above):
                    convergence = True
                    convergence_score = round(score_val / float(threshold_above), 2)
                if convergence:
                    convergence_risks.append({
                        "entity": signal["entity"],
                        "x_signal": signal,
                        "o_concept": mapping.get("node_label"),
                        "convergence_score": min(1.0, convergence_score),
                    })

        return {
            "x_signals": x_signals,
            "o_mappings": o_mappings,
            "convergence_risks": convergence_risks,
        }
    except Exception as exc:
        logger.error("tool_get_xo_context_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_case_history(ctx: CrystalContext, params: dict, **kwargs) -> dict:
    """Get CX case history for a contact or segment."""
    try:
        contact_id = params.get("contact_id")
        driver = params.get("driver")
        if not contact_id and not driver:
            return {"error": "contact_id or driver required"}

        conditions = ["org_id = %s"]
        args: list = [ctx.org_id]
        if contact_id:
            conditions.append("contact_id = %s")
            args.append(contact_id)
        if driver:
            conditions.append("driver_ref = %s")
            args.append(driver)

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    f"""SELECT id, title, status, severity, resolved_at, resolution_note
                        FROM cx_cases
                        WHERE {' AND '.join(conditions)}
                        ORDER BY created_at DESC LIMIT 50""",
                    args,
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]

        cases = []
        resolved_count = 0
        for row in rows:
            c = dict(zip(cols, row))
            c["id"] = str(c["id"]) if c.get("id") else None
            if c.get("resolved_at"):
                c["resolved_at"] = str(c["resolved_at"])
                resolved_count += 1
            cases.append(c)

        return {"cases": cases, "total": len(cases), "resolved_count": resolved_count}
    except Exception as exc:
        logger.error("tool_get_case_history_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_propose_create_case(ctx: CrystalContext, params: dict, **kwargs) -> dict:
    """Propose creating a CX case with real owner resolved."""
    try:
        # Resolve owner from driver_ref, account_id, or segment
        resolved_owner: dict = {
            "matched": False,
            "owner_user_id": None,
            "owner_label": None,
            "role_label": None,
            "escalation_user_id": None,
        }
        for dim, val in [
            ("driver", params.get("driver_ref", "")),
            ("account", params.get("account_id", "")),
            ("segment", params.get("segment", "")),
        ]:
            if val:
                route_result = await execute_get_ownership_route(
                    ctx, {"dimension": dim, "match_value": val}
                )
                if route_result.get("matched"):
                    resolved_owner = route_result
                    break

        return {
            "proposal_type": "case",
            "title": params.get("title", "Follow up with detractor"),
            "description": params.get("description", ""),
            "priority": params.get("priority", "high"),
            "business_rationale": params.get("business_rationale", ""),
            "confidence": params.get("confidence", 0.8),
            "params": {
                "contact_id": params.get("contact_id"),
                "response_id": params.get("response_id"),
                "survey_id": ctx.survey_id,
                "title": params.get("title"),
                "description": params.get("description"),
                "severity": params.get("severity", "high"),
                "category": params.get("category", "cx"),
                "driver_ref": params.get("driver_ref"),
                "owner_user_id": resolved_owner.get("owner_user_id"),
                "owner_label": resolved_owner.get("owner_label"),
                "role_label": resolved_owner.get("role_label"),
            },
            "requires_confirmation": True,
            "cta_label": "Create Case",
        }
    except Exception as exc:
        logger.error("tool_propose_create_case_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_propose_slack_alert(ctx: CrystalContext, params: dict, **kwargs) -> dict:
    """Propose sending a Slack alert via webhook URL stored in org config or params."""
    return {
        "proposal_type": "slack_notify",
        "title": params.get("title", "Send Slack alert"),
        "description": params.get("message", ""),
        "priority": params.get("priority", "medium"),
        "params": {
            "webhook_url": params.get("webhook_url"),
            "message": params.get("message"),
            "channel": params.get("channel", "#cx-alerts"),
            "case_id": params.get("case_id"),
        },
        "requires_confirmation": True,
        "cta_label": "Send Alert",
    }


# ── Support tools ─────────────────────────────────────────────────────────────
# These tools back the crystal-support skill. They query support-specific tables
# (support_docs, support_known_issues, support_changelog, support_tickets) and
# the org account state. All are org-scoped via ctx.org_id.

async def execute_search_support_docs(ctx: CrystalContext, params: dict) -> dict:
    """Search support docs by text query. Returns top matching docs with titles and excerpts."""
    try:
        query_text = params.get("query", "").strip()
        category = params.get("category")
        limit = min(int(params.get("limit", 5)), 20)
        if not query_text:
            return {"error": "query required"}
        conditions = ["(title ILIKE $1 OR content ILIKE $2)"]
        args: list = [f"%{query_text}%", f"%{query_text}%"]
        if category:
            conditions.append(f"category = ${len(args)+1}")
            args.append(category)
        conditions.append(f"(org_id = '__global__' OR org_id = ${len(args)+1})")
        args.append(ctx.org_id)
        conditions.append("pipeline_status = 'live' AND deleted_at IS NULL")
        args.append(limit)
        rows = await db.fetch(
            f"""SELECT key, title, category, LEFT(content, 400) AS excerpt
                FROM support_docs
                WHERE {' AND '.join(conditions)}
                ORDER BY CASE WHEN title ILIKE ${len(args)} THEN 0 ELSE 1 END, updated_at DESC
                LIMIT ${len(args)+1}""",
            *args, f"%{query_text}%", limit
        )
        docs = [dict(r) for r in rows]
        return {"docs": docs, "total": len(docs)}
    except Exception as exc:
        logger.error("tool_search_support_docs_failed", error=str(exc))
        return {"error": str(exc)}


async def execute_get_doc_by_key(ctx: CrystalContext, params: dict) -> dict:
    """Retrieve a specific support doc by its key slug."""
    try:
        doc_key = params.get("doc_key", "").strip()
        if not doc_key:
            return {"error": "doc_key required"}
        rows = await db.fetch(
            """SELECT key, title, category, content, updated_at
               FROM support_docs
               WHERE key = $1
                 AND (org_id = '__global__' OR org_id = $2)
                 AND pipeline_status = 'live' AND deleted_at IS NULL
               LIMIT 1""",
            doc_key, ctx.org_id
        )
        if not rows:
            return {"error": f"doc not found: {doc_key}"}
        doc = dict(rows[0])
        if doc.get("updated_at"):
            doc["updated_at"] = str(doc["updated_at"])
        return doc
    except Exception as exc:
        logger.error("tool_get_doc_by_key_failed", error=str(exc))
        return {"error": str(exc)}


async def execute_get_feature_status(ctx: CrystalContext, params: dict) -> dict:
    """Get status and docs for a specific Experient feature."""
    try:
        feature_name = params.get("feature_name", "").strip()
        if not feature_name:
            return {"error": "feature_name required"}
        doc_rows = await db.fetch(
            """SELECT key, title, category, LEFT(content, 300) AS excerpt
               FROM support_docs
               WHERE category = 'feature' AND title ILIKE $1
                 AND (org_id = '__global__' OR org_id = $2)
                 AND pipeline_status = 'live' AND deleted_at IS NULL
               ORDER BY updated_at DESC LIMIT 5""",
            f"%{feature_name}%", ctx.org_id
        )
        docs = [dict(r) for r in doc_rows]
        issue_rows = await db.fetch(
            """SELECT id, title, severity, status, workaround
               FROM support_known_issues
               WHERE (affected_features @> ARRAY[$1]::text[] OR title ILIKE $2)
                 AND status != 'resolved'
               ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
               LIMIT 5""",
            feature_name.lower(), f"%{feature_name}%"
        )
        known_issues = [dict(r) for r in issue_rows]
        for issue in known_issues:
            if issue.get("id"):
                issue["id"] = str(issue["id"])
        has_critical = any(i.get("severity") == "critical" for i in known_issues)
        has_high = any(i.get("severity") == "high" for i in known_issues)
        status = "degraded" if has_critical else "partial" if has_high else "live" if docs else "unknown"
        return {"feature": feature_name, "status": status, "docs": docs, "known_issues": known_issues}
    except Exception as exc:
        logger.error("tool_get_feature_status_failed", error=str(exc))
        return {"error": str(exc)}


async def execute_get_account_state(ctx: CrystalContext, params: dict) -> dict:
    """Get current org account state: credits, plan, active surveys."""
    try:
        org_rows = await db.fetch(
            "SELECT plan_tier, billing_status, trial_ends_at FROM org_profiles WHERE org_id = $1 LIMIT 1",
            ctx.org_id
        )
        org_row = org_rows[0] if org_rows else None
        plan = (org_row["plan_tier"] if org_row else None) or "unknown"
        billing_status = (org_row["billing_status"] if org_row else None) or "unknown"
        trial_ends_at = str(org_row["trial_ends_at"]) if org_row and org_row.get("trial_ends_at") else None
        credit_rows = await db.fetch(
            "SELECT balance FROM credit_ledger WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1",
            ctx.org_id
        )
        credits_remaining = int(credit_rows[0]["balance"]) if credit_rows and credit_rows[0].get("balance") is not None else 0
        count_rows = await db.fetch(
            "SELECT COUNT(*)::int AS cnt FROM surveys WHERE org_id = $1 AND status = 'active' AND deleted_at IS NULL",
            ctx.org_id
        )
        active_surveys = count_rows[0]["cnt"] if count_rows else 0
        has_issues = credits_remaining <= 0 or billing_status not in ("active", "trialing", "unknown")
        return {"plan": plan, "credits_remaining": credits_remaining, "active_surveys": active_surveys,
                "billing_status": billing_status, "trial_ends_at": trial_ends_at, "has_issues": has_issues}
    except Exception as exc:
        logger.error("tool_get_account_state_failed", error=str(exc))
        return {"error": str(exc)}


async def execute_get_known_issues(ctx: CrystalContext, params: dict) -> dict:
    """Get active known issues, optionally filtered by feature."""
    try:
        feature = params.get("feature")
        if feature:
            rows = await db.fetch(
                """SELECT id, title, severity, status, workaround, affected_features, created_at
                   FROM support_known_issues
                   WHERE status != 'resolved'
                     AND (affected_features @> ARRAY[$1]::text[] OR title ILIKE $2)
                   ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
                   LIMIT 20""",
                feature.lower(), f"%{feature}%"
            )
        else:
            rows = await db.fetch(
                """SELECT id, title, severity, status, workaround, affected_features, created_at
                   FROM support_known_issues
                   WHERE status != 'resolved'
                   ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
                   LIMIT 20"""
            )
        issues = []
        for row in rows:
            issue = dict(row)
            if issue.get("id"):
                issue["id"] = str(issue["id"])
            if issue.get("created_at"):
                issue["created_at"] = str(issue["created_at"])
            issues.append(issue)
        return {"issues": issues, "count": len(issues)}
    except Exception as exc:
        logger.error("tool_get_known_issues_failed", error=str(exc))
        return {"error": str(exc)}


async def execute_get_system_status(ctx: CrystalContext, params: dict) -> dict:
    """Get current system health status based on active known issue severity."""
    try:
        rows = await db.fetch(
            """SELECT severity, COUNT(*)::int AS issue_count
               FROM support_known_issues
               WHERE status != 'resolved' AND severity IN ('critical', 'high')
               GROUP BY severity"""
        )
        counts = {r["severity"]: r["issue_count"] for r in rows}
        critical_count = counts.get("critical", 0)
        high_count = counts.get("high", 0)
        overall_status = "degraded" if critical_count > 0 else "partial" if high_count > 0 else "operational"
        return {"status": overall_status, "critical_issues": critical_count, "high_issues": high_count}
    except Exception as exc:
        logger.error("tool_get_system_status_failed", error=str(exc))
        return {"error": str(exc)}


async def execute_create_support_ticket(ctx: CrystalContext, params: dict) -> dict:
    """Create a support escalation ticket with full Crystal conversation context."""
    try:
        import uuid as _uuid
        title = params.get("title", "").strip()
        description = params.get("description", "").strip()
        severity = params.get("severity", "medium")
        crystal_context_data = params.get("crystal_context") or {}
        if not title:
            return {"error": "title required"}
        if not description:
            return {"error": "description required"}
        if severity not in ("low", "medium", "high", "critical"):
            severity = "medium"
        ticket_id = str(_uuid.uuid4())
        await db.execute(
            """INSERT INTO support_tickets
                 (id, org_id, user_id, title, description, severity, status, crystal_context, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,'open',$7::jsonb,NOW())""",
            ticket_id, ctx.org_id, ctx.user_id or "",
            title[:255], description[:4000], severity,
            _json.dumps(crystal_context_data)
        )
        sla = {"critical": "within 1 hour", "high": "within 4 hours",
               "medium": "within 1 business day", "low": "within 2 business days"}
        return {"ticket_id": ticket_id, "status": "created",
                "message": f"Ticket created. A support engineer will respond {sla.get(severity, 'shortly')}."}
    except Exception as exc:
        logger.error("tool_create_support_ticket_failed", error=str(exc))
        return {"error": str(exc)}


async def execute_get_changelog_recent(ctx: CrystalContext, params: dict) -> dict:
    """Get recent changelog entries."""
    try:
        import json as _json_inner
        limit = min(int(params.get("limit", 5)), 20)
        rows = await db.fetch(
            "SELECT version, released_at, summary, changes FROM support_changelog ORDER BY released_at DESC LIMIT $1",
            limit
        )
        entries = []
        for row in rows:
            entry = dict(row)
            if entry.get("released_at"):
                entry["released_at"] = str(entry["released_at"])
            changes = entry.get("changes")
            if isinstance(changes, str):
                try:
                    entry["changes"] = _json_inner.loads(changes)
                except Exception:
                    entry["changes"] = [changes]
            entries.append(entry)
        return {"entries": entries, "count": len(entries)}
    except Exception as exc:
        logger.error("tool_get_changelog_recent_failed", error=str(exc))
        return {"error": str(exc)}


# ── Insight Pipeline v2 — checkpoint chain / trail / report tools (Phase 6) ───
# All org-scoped; read insight_checkpoints_v2 / insight_reports / settings. Each
# returns {"error": ...} on failure rather than raising. Per 07_CRYSTAL_INTEGRATION.

_REPORT_URL = "/experience/surveys/{sid}/intelligence/reports/{rid}"
_TRAIL_URL = "/experience/surveys/{sid}/intelligence/trail/{cid}"

# Tag Report — routes per docs/tag-report/DESIGN.md Appendix C (matches
# app/src/constants/routes.ts TAG_REPORT / TAG_REPORT_TRAIL exactly).
_TAG_REPORT_URL = "/app/experience/tags/{tag_id}/report/{run_id}"
_TAG_REPORT_TRAIL_URL = "/app/experience/tags/{tag_id}/report/trail"


def _ckpt_summary(nps, nps_delta, emerged_count: int | None = None) -> str:
    """One-line checkpoint summary, e.g. 'NPS 41 (−3.2) · 2 emerged themes'."""
    parts: list[str] = []
    if nps is not None:
        if nps_delta is not None:
            sign = "+" if nps_delta >= 0 else "−"
            parts.append(f"NPS {nps:g} ({sign}{abs(nps_delta):g})")
        else:
            parts.append(f"NPS {nps:g}")
    if emerged_count:
        parts.append(f"{emerged_count} emerged theme{'s' if emerged_count != 1 else ''}")
    return " · ".join(parts) or "Checkpoint"


def _coerce_delta(raw) -> dict | None:
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except Exception:
            return None
    return raw if isinstance(raw, dict) else None


async def execute_get_checkpoint_chain(ctx: CrystalContext, params: dict) -> dict:
    """Walk the verified automated checkpoint chain via parent_checkpoint_id (v2).

    Falls back to legacy survey_insight_checkpoints (checkpoint_number order) when v2
    is empty/absent. Returns checkpoints newest-first with summary + trail URL.
    """
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        lookback = min(int(params.get("lookback", 5)), 20)
        lane = params.get("lane", "automated")
        if not survey_id:
            return {"error": "survey_id required"}

        rows: list[dict] = []
        try:
            async with db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    lane_clause = "" if lane == "all" else "AND lane = %s"
                    args: list = [survey_id, ctx.org_id]
                    if lane != "all":
                        args.append(lane)
                    args.append(lookback)
                    await cur.execute(
                        f"""SELECT id, checkpoint_number, parent_checkpoint_id, lane, created_at,
                                   nps_at_checkpoint, new_response_count, delta_from_prior,
                                   meaningful_delta
                            FROM insight_checkpoints_v2
                            WHERE survey_id = %s AND org_id = %s {lane_clause}
                            ORDER BY checkpoint_number DESC
                            LIMIT %s""",
                        args,
                    )
                    fetched = await cur.fetchall()
                    if fetched:
                        cols = [d[0] for d in cur.description]
                        rows = [dict(zip(cols, r)) for r in fetched]
        except Exception as exc:
            logger.debug("get_checkpoint_chain_v2_unavailable", error=str(exc))
            rows = []

        # ── Verified walk: order by parent linkage when ids/parents present ────
        if rows and any(r.get("parent_checkpoint_id") for r in rows):
            by_id = {str(r["id"]): r for r in rows}
            parent_ids = {str(r["parent_checkpoint_id"]) for r in rows if r.get("parent_checkpoint_id")}
            head = next(
                (r for r in rows if str(r["id"]) not in parent_ids),
                rows[0],
            )
            ordered: list[dict] = []
            seen: set[str] = set()
            cur_node = head
            while cur_node is not None and str(cur_node["id"]) not in seen:
                ordered.append(cur_node)
                seen.add(str(cur_node["id"]))
                pid = cur_node.get("parent_checkpoint_id")
                cur_node = by_id.get(str(pid)) if pid else None
            # Any rows not reachable via the chain (gaps) appended in number order.
            for r in rows:
                if str(r["id"]) not in seen:
                    ordered.append(r)
            rows = ordered[:lookback]

        # ── Legacy fallback ───────────────────────────────────────────────────
        if not rows:
            try:
                async with db._pool_conn().connection() as conn:
                    async with conn.cursor() as cur:
                        await cur.execute(
                            """SELECT id, checkpoint_number, NULL AS parent_checkpoint_id,
                                      'automated' AS lane, created_at,
                                      nps_at_checkpoint, NULL AS new_response_count,
                                      delta_from_prior, meaningful_delta
                               FROM survey_insight_checkpoints
                               WHERE survey_id = %s AND org_id = %s
                               ORDER BY checkpoint_number DESC
                               LIMIT %s""",
                            (survey_id, ctx.org_id, lookback),
                        )
                        fetched = await cur.fetchall()
                        cols = [d[0] for d in cur.description]
                        rows = [dict(zip(cols, r)) for r in fetched]
            except Exception as exc:
                logger.warning("get_checkpoint_chain_legacy_failed", error=str(exc))
                return {"error": str(exc)}

        checkpoints = []
        for r in rows:
            delta = _coerce_delta(r.get("delta_from_prior")) or {}
            nps = float(r["nps_at_checkpoint"]) if r.get("nps_at_checkpoint") is not None else None
            nps_delta = delta.get("nps_delta")
            emerged = ((delta.get("topic_changes") or {}).get("emerged")) or []
            cid = str(r["id"])
            checkpoints.append({
                "id": cid,
                "checkpoint_number": r.get("checkpoint_number"),
                "lane": r.get("lane"),
                "created_at": str(r["created_at"]) if r.get("created_at") else None,
                "nps": nps,
                "nps_delta": nps_delta,
                "new_response_count": r.get("new_response_count"),
                "meaningful_delta": r.get("meaningful_delta"),
                "summary": _ckpt_summary(nps, nps_delta, len(emerged)),
                "url": _TRAIL_URL.format(sid=survey_id, cid=cid),
            })
        return {"checkpoints": checkpoints, "total_returned": len(checkpoints)}
    except Exception as exc:
        logger.error("tool_get_checkpoint_chain_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_insight_settings(ctx: CrystalContext, params: dict) -> dict:
    """Return the effective merged insight settings (reuses lib/insight_settings)."""
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        if not survey_id:
            return {"error": "survey_id required"}
        from crystalos.lib.insight_settings import load_insight_settings
        settings = await load_insight_settings(survey_id, ctx.org_id)
        # Stringify any non-JSON-native values defensively.
        clean = {k: (str(v) if hasattr(v, "isoformat") else v) for k, v in settings.items()}
        return {"survey_id": survey_id, "settings": clean}
    except Exception as exc:
        logger.error("tool_get_insight_settings_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_insight_report(ctx: CrystalContext, params: dict) -> dict:
    """Fetch an insight_reports row + blob document summary + report URL.

    Output carries render_hint='document' so the frontend renders an
    InsightDocumentCard. report_id / checkpoint_id are optional filters; if neither
    is given, the latest ready report for the survey is returned.
    """
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        report_id = params.get("report_id")
        checkpoint_id = params.get("checkpoint_id")
        if not survey_id:
            return {"error": "survey_id required"}

        conditions = ["survey_id = %s", "org_id = %s"]
        args: list = [survey_id, ctx.org_id]
        if report_id:
            conditions.append("id = %s")
            args.append(report_id)
        elif checkpoint_id:
            conditions.append("checkpoint_id = %s")
            args.append(checkpoint_id)

        row = None
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    f"""SELECT id, run_mode, label, status, created_by, created_at,
                               blob_ref, summary_headline, trust_score_avg, checkpoint_id,
                               window_start, window_end
                        FROM insight_reports
                        WHERE {' AND '.join(conditions)}
                        ORDER BY created_at DESC LIMIT 1""",
                    args,
                )
                r = await cur.fetchone()
                if r:
                    cols = [d[0] for d in cur.description]
                    row = dict(zip(cols, r))

        if not row:
            return {"report": None, "render_hint": "document",
                    "message": "No insight report found for this survey."}

        rid = str(row["id"])
        # Load the blob document (executive summary, themes, insights) — best-effort.
        blob: dict = {}
        if row.get("blob_ref"):
            try:
                from crystalos.lib.checkpoint_store import read_checkpoint_blob
                blob = await read_checkpoint_blob(row["blob_ref"]) or {}
            except Exception as exc:
                logger.debug("get_insight_report_blob_read_failed", ref=row.get("blob_ref"), error=str(exc))
                blob = {}

        blob_insights = blob.get("insights") or []
        citations_count = 0
        for ins in blob_insights:
            citations_count += len(ins.get("citations_json") or [])
        manifest = blob.get("citations_manifest") or {}
        if manifest.get("total_citations"):
            citations_count = manifest["total_citations"]

        report_url = _REPORT_URL.format(sid=survey_id, rid=rid)
        ckpt_id = str(row["checkpoint_id"]) if row.get("checkpoint_id") else None
        document_url = (
            _TRAIL_URL.format(sid=survey_id, cid=ckpt_id) if ckpt_id else report_url
        )
        return {
            "report_id": rid,
            "title": row.get("summary_headline") or f"Insight Report · {row.get('run_mode', '')}",
            "run_mode": row.get("run_mode"),
            "status": row.get("status"),
            "label": row.get("label"),
            "created_at": str(row["created_at"]) if row.get("created_at") else None,
            "created_by": row.get("created_by"),
            "executive_summary": blob.get("executive_summary", ""),
            "themes": blob.get("themes", [])[:20],
            "insights": [
                {"headline": i.get("headline"), "layer": i.get("layer"),
                 "category": i.get("category"), "trust_score": i.get("trust_score")}
                for i in blob_insights[:20]
            ],
            "nps": blob.get("nps"),
            "csat": blob.get("csat"),
            "ces": blob.get("ces"),
            "trust_score_avg": float(row["trust_score_avg"]) if row.get("trust_score_avg") is not None else None,
            "citations_count": citations_count,
            "checkpoint_id": ckpt_id,
            "report_url": report_url,
            "document_url": document_url,
            "render_hint": "document",
        }
    except Exception as exc:
        logger.error("tool_get_insight_report_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_insight_trail(ctx: CrystalContext, params: dict) -> dict:
    """List checkpoint/report nodes for a survey (Insight Trail). v2 with legacy fallback."""
    try:
        survey_id = params.get("survey_id") or ctx.survey_id
        lane = params.get("lane", "all")
        limit = min(int(params.get("limit", 10)), 50)
        if not survey_id:
            return {"error": "survey_id required"}

        nodes: list[dict] = []
        try:
            async with db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    lane_clause = "" if lane == "all" else "AND lane = %s"
                    args: list = [survey_id, ctx.org_id]
                    if lane != "all":
                        args.append(lane)
                    args.append(limit)
                    await cur.execute(
                        f"""SELECT id, checkpoint_number, lane, created_at, created_by,
                                   nps_at_checkpoint, delta_from_prior, meaningful_delta,
                                   report_label, run_mode
                            FROM insight_checkpoints_v2
                            WHERE survey_id = %s AND org_id = %s {lane_clause}
                            ORDER BY created_at DESC
                            LIMIT %s""",
                        args,
                    )
                    fetched = await cur.fetchall()
                    cols = [d[0] for d in cur.description] if fetched else []
                    for r in fetched:
                        row = dict(zip(cols, r))
                        delta = _coerce_delta(row.get("delta_from_prior")) or {}
                        nps = float(row["nps_at_checkpoint"]) if row.get("nps_at_checkpoint") is not None else None
                        emerged = ((delta.get("topic_changes") or {}).get("emerged")) or []
                        cid = str(row["id"])
                        nodes.append({
                            "id": cid,
                            "type": "report" if row.get("lane") == "manual" else "checkpoint",
                            "lane": row.get("lane"),
                            "checkpoint_number": row.get("checkpoint_number"),
                            "created_at": str(row["created_at"]) if row.get("created_at") else None,
                            "created_by": row.get("created_by"),
                            "summary": row.get("report_label") or _ckpt_summary(nps, delta.get("nps_delta"), len(emerged)),
                            "url": _TRAIL_URL.format(sid=survey_id, cid=cid),
                            "meaningful_delta": row.get("meaningful_delta"),
                        })
        except Exception as exc:
            logger.debug("get_insight_trail_v2_unavailable", error=str(exc))
            nodes = []

        if not nodes:
            try:
                async with db._pool_conn().connection() as conn:
                    async with conn.cursor() as cur:
                        await cur.execute(
                            """SELECT id, checkpoint_number, created_at, created_by,
                                      nps_at_checkpoint, delta_from_prior, meaningful_delta
                               FROM survey_insight_checkpoints
                               WHERE survey_id = %s AND org_id = %s
                               ORDER BY created_at DESC LIMIT %s""",
                            (survey_id, ctx.org_id, limit),
                        )
                        fetched = await cur.fetchall()
                        cols = [d[0] for d in cur.description] if fetched else []
                        for r in fetched:
                            row = dict(zip(cols, r))
                            delta = _coerce_delta(row.get("delta_from_prior")) or {}
                            nps = float(row["nps_at_checkpoint"]) if row.get("nps_at_checkpoint") is not None else None
                            cid = str(row["id"])
                            nodes.append({
                                "id": cid,
                                "type": "checkpoint",
                                "lane": "automated",
                                "checkpoint_number": row.get("checkpoint_number"),
                                "created_at": str(row["created_at"]) if row.get("created_at") else None,
                                "created_by": row.get("created_by"),
                                "summary": _ckpt_summary(nps, delta.get("nps_delta")),
                                "url": _TRAIL_URL.format(sid=survey_id, cid=cid),
                                "meaningful_delta": row.get("meaningful_delta"),
                            })
            except Exception as exc:
                logger.warning("get_insight_trail_legacy_failed", error=str(exc))
                return {"error": str(exc)}

        return {"nodes": nodes, "count": len(nodes)}
    except Exception as exc:
        logger.error("tool_get_insight_trail_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def _load_checkpoint_row(ctx: CrystalContext, checkpoint_id: str) -> dict | None:
    """Load a single checkpoint row (v2 first, then legacy). Org-scoped. None if absent."""
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT id, checkpoint_number, parent_checkpoint_id, lane, created_at,
                              nps_at_checkpoint, csat_at_checkpoint, ces_at_checkpoint,
                              new_response_count, response_count_at_checkpoint,
                              delta_from_prior, meaningful_delta, lineage_json
                       FROM insight_checkpoints_v2
                       WHERE id = %s AND org_id = %s LIMIT 1""",
                    (checkpoint_id, ctx.org_id),
                )
                r = await cur.fetchone()
                if r:
                    return dict(zip([d[0] for d in cur.description], r))
    except Exception as exc:
        logger.debug("load_checkpoint_v2_failed", error=str(exc))
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT id, checkpoint_number,
                              NULL AS parent_checkpoint_id, 'automated' AS lane, created_at,
                              nps_at_checkpoint, csat_at_checkpoint, ces_at_checkpoint,
                              NULL AS new_response_count, response_count_at_checkpoint,
                              delta_from_prior, meaningful_delta, NULL AS lineage_json
                       FROM survey_insight_checkpoints
                       WHERE id = %s AND org_id = %s LIMIT 1""",
                    (checkpoint_id, ctx.org_id),
                )
                r = await cur.fetchone()
                if r:
                    return dict(zip([d[0] for d in cur.description], r))
    except Exception as exc:
        logger.debug("load_checkpoint_legacy_failed", error=str(exc))
    return None


async def execute_get_checkpoint_detail(ctx: CrystalContext, params: dict) -> dict:
    """Single checkpoint node + delta + lineage."""
    try:
        checkpoint_id = params.get("checkpoint_id")
        if not checkpoint_id:
            return {"error": "checkpoint_id required"}
        row = await _load_checkpoint_row(ctx, checkpoint_id)
        if not row:
            return {"error": "checkpoint not found"}
        delta = _coerce_delta(row.get("delta_from_prior"))
        lineage = _coerce_delta(row.get("lineage_json")) or {}
        prior_refs = lineage.get("prior_checkpoint_refs", [])
        return {
            "id": str(row["id"]),
            "checkpoint_number": row.get("checkpoint_number"),
            "lane": row.get("lane"),
            "created_at": str(row["created_at"]) if row.get("created_at") else None,
            "nps": float(row["nps_at_checkpoint"]) if row.get("nps_at_checkpoint") is not None else None,
            "csat": float(row["csat_at_checkpoint"]) if row.get("csat_at_checkpoint") is not None else None,
            "ces": float(row["ces_at_checkpoint"]) if row.get("ces_at_checkpoint") is not None else None,
            "new_response_count": row.get("new_response_count"),
            "response_count": row.get("response_count_at_checkpoint"),
            "meaningful_delta": row.get("meaningful_delta"),
            "delta_from_prior": delta,
            "parent_checkpoint_id": str(row["parent_checkpoint_id"]) if row.get("parent_checkpoint_id") else None,
            "prior_checkpoint_refs": prior_refs,
            "citations_count": len(lineage.get("new_response_ids", [])) or None,
        }
    except Exception as exc:
        logger.error("tool_get_checkpoint_detail_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_compare_checkpoints(ctx: CrystalContext, params: dict) -> dict:
    """Side-by-side metric + topic diff between two checkpoints."""
    try:
        id_a = params.get("checkpoint_id_a")
        id_b = params.get("checkpoint_id_b")
        if not id_a or not id_b:
            return {"error": "checkpoint_id_a and checkpoint_id_b required"}
        row_a = await _load_checkpoint_row(ctx, id_a)
        row_b = await _load_checkpoint_row(ctx, id_b)
        if not row_a or not row_b:
            return {"error": "one or both checkpoints not found"}

        def _node(row: dict) -> dict:
            return {
                "id": str(row["id"]),
                "checkpoint_number": row.get("checkpoint_number"),
                "nps": float(row["nps_at_checkpoint"]) if row.get("nps_at_checkpoint") is not None else None,
                "csat": float(row["csat_at_checkpoint"]) if row.get("csat_at_checkpoint") is not None else None,
                "ces": float(row["ces_at_checkpoint"]) if row.get("ces_at_checkpoint") is not None else None,
                "created_at": str(row["created_at"]) if row.get("created_at") else None,
            }

        a, b = _node(row_a), _node(row_b)
        metric_delta = {}
        for m in ("nps", "csat", "ces"):
            if a[m] is not None and b[m] is not None:
                metric_delta[m] = round(b[m] - a[m], 2)

        def _topic_names(row: dict) -> set[str]:
            delta = _coerce_delta(row.get("delta_from_prior")) or {}
            tc = delta.get("topic_changes") or {}
            names: set[str] = set()
            for key in ("emerged", "persisted", "growing"):
                for t in tc.get(key, []) or []:
                    names.add(t["name"] if isinstance(t, dict) else str(t))
            return names

        topics_a, topics_b = _topic_names(row_a), _topic_names(row_b)
        topic_diff = {
            "only_in_a": sorted(topics_a - topics_b),
            "only_in_b": sorted(topics_b - topics_a),
            "shared": sorted(topics_a & topics_b),
        }
        return {
            "checkpoint_a": a,
            "checkpoint_b": b,
            "metric_delta": metric_delta,
            "topic_diff": topic_diff,
        }
    except Exception as exc:
        logger.error("tool_compare_checkpoints_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


# ── Insight Pipeline v2 — report action proposals (Phase 6) ───────────────────
# proposal_type aliases (agents/crystal.py::_PROPOSAL_TYPE_ALIASES):
#   manual_insight_run   → trigger_manual_insight_run
#   view_report          → view_report (pass-through)
#   generate_intelligence_report → generate_intelligence_report (pass-through)

async def execute_propose_manual_insight_run(ctx: CrystalContext, params: dict) -> dict:
    """Propose a manual Expert/Quick insight run (frontend → POST /api/insights/:id/runs)."""
    survey_id = params.get("survey_id") or ctx.survey_id
    mode = params.get("mode") or "manual_expert"
    if mode not in ("manual_expert", "manual_quick"):
        mode = "manual_expert"
    label = params.get("label") or ("Expert report" if mode == "manual_expert" else "Quick report")
    return {
        "proposal_type": "manual_insight_run",
        "title": f"Generate {('Expert' if mode == 'manual_expert' else 'Quick')} report"[:60],
        "description": f"Run a {('deep-dive Expert' if mode == 'manual_expert' else 'quick')} insight analysis for this survey.",
        "requires_confirmation": True,
        "params": {
            "survey_id":    survey_id,
            "mode":         "expert" if mode == "manual_expert" else "quick",
            "window_start": params.get("window_start"),
            "window_end":   params.get("window_end"),
            "label":        label,
        },
        "cta_label": "Generate Report",
        "business_rationale": (
            "Produces a grounded, citation-backed report so the team can act on the "
            "latest experience signals with confidence."
        )[:159],
    }


async def execute_propose_view_report(ctx: CrystalContext, params: dict) -> dict:
    """Propose opening an existing report (read-only navigation — no API call)."""
    survey_id = params.get("survey_id") or ctx.survey_id
    report_id = params.get("report_id")
    checkpoint_id = params.get("checkpoint_id")
    url = params.get("url")
    if not url:
        if checkpoint_id:
            url = _TRAIL_URL.format(sid=survey_id, cid=checkpoint_id)
        elif report_id:
            url = _REPORT_URL.format(sid=survey_id, rid=report_id)
        else:
            url = f"/experience/surveys/{survey_id}/intelligence"
    return {
        "proposal_type": "view_report",
        "title": "Open insight report"[:60],
        "description": params.get("summary") or "Open the existing insight report.",
        "requires_confirmation": True,
        "params": {
            "report_id":     report_id,
            "checkpoint_id": checkpoint_id,
            "url":           url,
            "summary":       params.get("summary", ""),
        },
        "cta_label": "Open Report",
    }


async def execute_propose_generate_intelligence_report(ctx: CrystalContext, params: dict) -> dict:
    """Propose generating a fresh report (frontend → trigger endpoint, shows credits)."""
    survey_id = params.get("survey_id") or ctx.survey_id
    estimated_credits = params.get("estimated_credits")
    if estimated_credits is None:
        # Resolve from settings so the confirm dialog shows a real number.
        try:
            from crystalos.lib.insight_settings import load_insight_settings, resolve_credit_cost
            settings = await load_insight_settings(survey_id, ctx.org_id)
            estimated_credits = resolve_credit_cost("automated_incremental", settings, include_report=True)
        except Exception:
            estimated_credits = 20
    return {
        "proposal_type": "generate_intelligence_report",
        "title": "Generate intelligence report"[:60],
        "description": f"Generate a fresh intelligence report (~{estimated_credits} credits).",
        "requires_confirmation": True,
        "params": {
            "survey_id":         survey_id,
            "estimated_credits": int(estimated_credits),
        },
        "estimated_credits": int(estimated_credits),
        "cta_label": "Generate Report",
    }


# ── Tag Report tools (cross-survey trust-weighted rollup) ────────────────────
# Read-only, full stop — these tools only ever read group_insight_runs /
# group_insight_run_sources / group_insights rows already written by
# graphs/tag_report.py. They never trigger generation (that only happens via
# the propose_generate_tag_report action-proposal path, which the frontend
# posts to a trigger endpoint on user confirmation — this module makes no such
# call itself). Every query below is org_id-scoped, including a tag-ownership
# check before any data is read, so a client-supplied tag_id from a different
# org can never leak data.

async def execute_list_tags(ctx: CrystalContext, params: dict) -> dict:
    """Resolve tags by name (case-insensitive substring) or list recent tags.

    Always org-scoped. This is how Crystal turns a user's reference to a tag
    ("the onboarding tag") into a real tag_id before calling get_tag_report or
    any other tag/group-scoped tool.
    """
    try:
        search = (params.get("query") or "").strip()
        limit = min(int(params.get("limit", 10)), 50)

        conditions = ["t.org_id = %s"]
        args: list = [ctx.org_id]
        if search:
            conditions.append("t.name ILIKE %s")
            args.append(f"%{search}%")
        args.append(limit)

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    f"""SELECT t.id, t.name, t.color,
                               (SELECT COUNT(*)::int FROM survey_tag_mappings m
                                  JOIN surveys s ON s.id = m.survey_id
                                WHERE m.tag_id = t.id AND m.org_id = t.org_id
                                  AND s.deleted_at IS NULL) AS survey_count
                        FROM survey_tags t
                        WHERE {' AND '.join(conditions)}
                        ORDER BY t.created_at DESC
                        LIMIT %s""",
                    args,
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description] if rows else []

        tags = []
        for row in rows:
            r = dict(zip(cols, row))
            tags.append({
                "tag_id": str(r["id"]),
                "name": r.get("name"),
                "color": r.get("color"),
                "survey_count": r.get("survey_count") or 0,
            })
        return {"tags": tags, "count": len(tags)}
    except Exception as exc:
        logger.error("tool_list_tags_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def _load_org_tag(ctx: CrystalContext, tag_id: str) -> dict | None:
    """Load a tag row, scoped to the caller's org. None if it doesn't exist or
    belongs to a different org — the caller must treat that identically to
    'not found' (never leak whether a cross-org tag_id exists)."""
    if not tag_id:
        return None
    async with db._pool_conn().connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT id, name, color FROM survey_tags WHERE id = %s AND org_id = %s",
                (tag_id, ctx.org_id),
            )
            row = await cur.fetchone()
            if not row:
                return None
            cols = [d[0] for d in cur.description]
            return dict(zip(cols, row))


def _parse_jsonish(value: Any) -> Any:
    """Best-effort JSON parse — group_insight_runs/group_insights JSONB columns
    sometimes arrive as already-decoded Python objects and sometimes as raw
    strings, depending on the driver/cursor path. Mirrors tagReportView.ts's
    parseJsonMaybe/parseArrayMaybe so this stays a faithful port."""
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return None


def _approximate_trust_score(response_count: int) -> int:
    """Monotonic-in-response-count display/sort proxy — faithful port of
    tagReportView.ts's approximateTrustScore. Not the real CrystalOS trust
    score (that's computed in-memory during generation and never persisted
    per-survey anywhere in the schema); this exists only so survey_breakdown's
    field NAME matches the backend's shape exactly, for the same reason the
    rest of this port is line-for-line rather than reinvented."""
    if response_count <= 0:
        return 0
    return max(0, min(100, round(40 + 15 * math.log2(response_count + 1))))


def _build_tag_metric_tracks(insights: list[dict], sources: list[dict], run: dict) -> list[dict]:
    """Port of backend/src/lib/tagReportView.ts::buildMetricTracks (authoritative
    reference for this shape — see that file's docstring for the full history of
    why the shape looks the way it does). Kept a faithful line-for-line port
    rather than reinvented so Crystal's prose and the Tag Report page never
    disagree about what a given run's data means.
    """
    stream_events = _parse_jsonish(run.get("stream_events")) or []
    sources_by_survey = {s["survey_id"]: s for s in sources}
    is_custom_range = run.get("run_mode") == "custom_range"

    comparability_warnings = [e for e in stream_events if e.get("event") == "comparability_warning"]
    corroboration_events = [e for e in stream_events if e.get("event") == "corroboration_detected"]
    bracket_delta_events = [e for e in stream_events if e.get("event") == "bracket_delta_computed"]

    tracks: list[dict] = []
    for row in insights:
        metric_key = row.get("metric_key")
        if not metric_key:
            continue
        metric_json = _parse_jsonish(row.get("metric_json")) or {}
        eligible_survey_ids = row.get("survey_ids") or []
        confidence_tier = metric_json.get("confidence_tier")
        single_survey_sourced = confidence_tier == "insufficient" or len(eligible_survey_ids) == 1

        # A metric-scoped warning (has metric_key — R-T3's question_type_mismatch/
        # scale_mismatch/cadence_mismatch) must match THIS track's metric_key, not
        # just overlap on survey_id. Survey-scoped warnings (temporal_offset/
        # staleness, no metric_key) match on survey overlap alone.
        warnings = [
            w for w in comparability_warnings
            if any(sid in eligible_survey_ids for sid in (w.get("affected_survey_ids") or []))
            and (w.get("metric_key") is None or w.get("metric_key") == metric_key)
        ]

        corroborated_with: set[str] = set()
        for evt in corroboration_events:
            evt_tracks = evt.get("tracks") or []
            if metric_key in evt_tracks:
                corroborated_with.update(t for t in evt_tracks if t != metric_key)

        # Only real, response-level citations (survey_id + response_id present)
        # are exposed — the checkpoint-only placeholder shape has no response_id.
        citations = [
            c for c in (_parse_jsonish(row.get("citations_json")) or [])
            if isinstance(c, dict) and isinstance(c.get("response_id"), str)
        ]

        track = {
            "metric_key": metric_key,
            "headline": row.get("headline"),
            "narrative": row.get("narrative"),
            "trust_score": row.get("trust_score"),
            "eligible_survey_count": len(eligible_survey_ids),
            "agreement_count": metric_json.get("agreement_count"),
            "confidence_tier": confidence_tier,
            "merged_delta": metric_json.get("merged_delta"),
            "direction": metric_json.get("direction"),
            "single_survey_sourced": single_survey_sourced,
            "warnings": warnings,
            "citations": citations,
        }

        single_survey_id = metric_json.get("single_survey_id")
        if single_survey_sourced and single_survey_id:
            source = sources_by_survey.get(single_survey_id)
            if source and source.get("survey_title"):
                track["single_survey_name"] = source["survey_title"]
        if corroborated_with:
            track["corroborated_with"] = sorted(corroborated_with)

        if is_custom_range:
            breakdown = []
            for sid in eligible_survey_ids:
                source = sources_by_survey.get(sid) or {}
                delta_event = next((e for e in bracket_delta_events if e.get("survey_id") == sid), None)
                delta = delta_event.get(f"{metric_key}_delta") if delta_event else None
                breakdown.append({
                    "survey_id": sid,
                    "survey_title": source.get("survey_title"),
                    "trust_score": _approximate_trust_score(source.get("response_count_at_generation") or 0),
                    "delta": delta,
                    "no_comparison_available": delta is None,
                })
            breakdown.sort(key=lambda b: b["trust_score"], reverse=True)
            track["survey_breakdown"] = breakdown

        tracks.append(track)

    return tracks


def _build_tag_disclosure(run: dict, sources: list[dict]) -> dict:
    """Port of backend/src/lib/tagReportView.ts::buildDisclosure."""
    stream_events = _parse_jsonish(run.get("stream_events")) or []
    batch_fetched_events = [e for e in stream_events if e.get("event") == "batch_fetched"]
    pool_size = (batch_fetched_events[0].get("pool_size") if batch_fetched_events else 0) or 0
    examined_survey_ids = {s["survey_id"] for s in sources}
    included_survey_ids = {s["survey_id"] for s in sources if s.get("checkpoint_id")}
    return {
        "pool_size": pool_size,
        "examined_count": len(examined_survey_ids),
        "included_count": len(included_survey_ids),
        "backfill_occurred": len(batch_fetched_events) > 1,
    }


async def execute_get_tag_report(ctx: CrystalContext, params: dict) -> dict:
    """Fetch a Tag Report — the trust-weighted cross-survey rollup for a tag.

    tag_id is required and is always re-validated against ctx.org_id before any
    other query runs (never trust a client-supplied tag_id). run_id is an
    optional filter; when omitted, the latest run for the tag is used. Output
    carries render_hint='document' (mirrors execute_get_insight_report).
    """
    try:
        tag_id = params.get("tag_id") or (ctx.tag_ids[0] if ctx.tag_ids else None)
        run_id = params.get("run_id")
        if not tag_id:
            return {"error": "tag_id required"}

        tag = await _load_org_tag(ctx, tag_id)
        if tag is None:
            return {"error": "tag not found"}

        conditions = ["org_id = %s", "%s = ANY(tag_ids)"]
        args: list = [ctx.org_id, tag_id]
        if run_id:
            conditions.append("id = %s")
            args.append(run_id)

        run_row: dict | None = None
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    f"""SELECT id, run_mode, status, stream_events, created_at, completed_at
                        FROM group_insight_runs
                        WHERE {' AND '.join(conditions)}
                        ORDER BY created_at DESC LIMIT 1""",
                    args,
                )
                r = await cur.fetchone()
                if r:
                    cols = [d[0] for d in cur.description]
                    run_row = dict(zip(cols, r))

        if not run_row:
            return {
                "report": None, "tag_id": str(tag_id), "tag_name": tag.get("name"),
                "render_hint": "document",
                "message": "No Tag Report found for this tag.",
            }

        resolved_run_id = str(run_row["id"])

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT girs.survey_id, s.title AS survey_title, girs.checkpoint_id,
                              girs.trend_eligible, girs.response_count_at_generation,
                              girs.exclusion_reason
                       FROM group_insight_run_sources girs
                       LEFT JOIN surveys s ON s.id = girs.survey_id
                       WHERE girs.run_id = %s AND girs.org_id = %s""",
                    (resolved_run_id, ctx.org_id),
                )
                source_rows = await cur.fetchall()
                source_cols = [d[0] for d in cur.description] if source_rows else []

            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT metric_key, headline, narrative, trust_score, survey_ids,
                              citations_json, metric_json
                       FROM group_insights
                       WHERE run_id = %s AND org_id = %s AND metric_key IS NOT NULL""",
                    (resolved_run_id, ctx.org_id),
                )
                insight_rows = await cur.fetchall()
                insight_cols = [d[0] for d in cur.description] if insight_rows else []

        sources = []
        for row in source_rows:
            s = dict(zip(source_cols, row))
            s["survey_id"] = str(s["survey_id"])
            if s.get("checkpoint_id"):
                s["checkpoint_id"] = str(s["checkpoint_id"])
            sources.append(s)

        insights = []
        for row in insight_rows:
            i = dict(zip(insight_cols, row))
            i["survey_ids"] = [str(sid) for sid in (i.get("survey_ids") or [])]
            i["trust_score"] = float(i["trust_score"]) if i.get("trust_score") is not None else None
            insights.append(i)

        run_row["run_mode"] = run_row.get("run_mode") or "manual"
        metric_tracks = _build_tag_metric_tracks(insights, sources, run_row)
        disclosure = _build_tag_disclosure(run_row, sources)

        return {
            "run_id": resolved_run_id,
            "tag_id": str(tag_id),
            "tag_name": tag.get("name"),
            "run_mode": run_row.get("run_mode"),
            "status": run_row.get("status"),
            "created_at": str(run_row["created_at"]) if run_row.get("created_at") else None,
            "completed_at": str(run_row["completed_at"]) if run_row.get("completed_at") else None,
            "metric_tracks": metric_tracks,
            "disclosure": disclosure,
            "report_url": _TAG_REPORT_URL.format(tag_id=tag_id, run_id=resolved_run_id),
            "render_hint": "document",
        }
    except Exception as exc:
        logger.error("tool_get_tag_report_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_get_tag_report_trail(ctx: CrystalContext, params: dict) -> dict:
    """List the Tag Report run history for a tag (newest first), one-line summary
    per run + a trail URL. Mirrors execute_get_insight_trail's shape."""
    try:
        tag_id = params.get("tag_id") or (ctx.tag_ids[0] if ctx.tag_ids else None)
        limit = min(int(params.get("limit", 10)), 50)
        if not tag_id:
            return {"error": "tag_id required"}

        tag = await _load_org_tag(ctx, tag_id)
        if tag is None:
            return {"error": "tag not found"}

        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT id, run_mode, status, created_at, completed_at, parent_run_id, result_json
                       FROM group_insight_runs
                       WHERE org_id = %s AND %s = ANY(tag_ids)
                       ORDER BY created_at DESC LIMIT %s""",
                    (ctx.org_id, tag_id, limit),
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description] if rows else []

        nodes = []
        for row in rows:
            r = dict(zip(cols, row))
            result_json = _parse_jsonish(r.get("result_json")) or {}
            headline_count = result_json.get("metric_tracks_narrated") or 0
            rid = str(r["id"])
            mode = r.get("run_mode") or "manual"
            created_at = str(r["created_at"]) if r.get("created_at") else None
            summary = f"{mode} · {headline_count} finding{'s' if headline_count != 1 else ''}"
            if created_at:
                summary = f"{summary} · {created_at}"
            nodes.append({
                "run_id": rid,
                "run_mode": mode,
                "status": r.get("status"),
                "created_at": created_at,
                "completed_at": str(r["completed_at"]) if r.get("completed_at") else None,
                "parent_run_id": str(r["parent_run_id"]) if r.get("parent_run_id") else None,
                "headline_count": headline_count,
                "summary": summary,
                "url": _TAG_REPORT_URL.format(tag_id=tag_id, run_id=rid),
            })

        return {
            "tag_id": str(tag_id),
            "tag_name": tag.get("name"),
            "nodes": nodes,
            "count": len(nodes),
            "trail_url": _TAG_REPORT_TRAIL_URL.format(tag_id=tag_id),
        }
    except Exception as exc:
        logger.error("tool_get_tag_report_trail_failed", error=str(exc), traceback=traceback.format_exc())
        return {"error": str(exc)}


async def execute_propose_view_tag_report(ctx: CrystalContext, params: dict) -> dict:
    """Propose opening an existing Tag Report (read-only navigation — no API call).

    Fixed 2026-07-03 (security review, Riley — contained, but inconsistent with
    this module's own convention): this and execute_propose_generate_tag_report
    previously didn't call _load_org_tag before building a proposal, unlike
    execute_get_tag_report/execute_get_tag_report_trail. No live exploit existed
    (no DB/HTTP call happens in either function — the actual mutation/navigation
    only occurs after the user clicks Apply, and THAT path is independently
    org-scoped downstream), but gating here too means a garbage/cross-org tag_id
    is rejected up front with a clean error instead of silently producing a
    plausible-looking proposal, and lets the proposal surface the tag's real
    (validated) name instead of a generic title.
    """
    tag_id = params.get("tag_id") or (ctx.tag_ids[0] if ctx.tag_ids else None)
    if not tag_id:
        return {"error": "tag_id required"}
    tag = await _load_org_tag(ctx, tag_id)
    if tag is None:
        return {"error": "tag not found"}

    run_id = params.get("run_id")
    url = params.get("url")
    if not url:
        if run_id:
            url = _TAG_REPORT_URL.format(tag_id=tag_id, run_id=run_id)
        else:
            url = f"/app/experience/tags/{tag_id}/report"
    tag_name = tag.get("name")
    return {
        "proposal_type": "view_tag_report",
        "title": f"Open Tag Report for \"{tag_name}\""[:60] if tag_name else "Open Tag Report",
        "description": params.get("summary") or "Open the existing Tag Report.",
        "requires_confirmation": True,
        "params": {
            "tag_id": tag_id,
            "run_id": run_id,
            "url":    url,
            "summary": params.get("summary", ""),
        },
        "cta_label": "Open Tag Report",
    }


async def execute_propose_generate_tag_report(ctx: CrystalContext, params: dict) -> dict:
    """Propose generating a fresh Tag Report (frontend → tag-report trigger endpoint).

    Fixed 2026-07-03 (security review, Riley) — see execute_propose_view_tag_report's
    docstring for the full rationale; same _load_org_tag gate applied here.
    """
    tag_id = params.get("tag_id") or (ctx.tag_ids[0] if ctx.tag_ids else None)
    if not tag_id:
        return {"error": "tag_id required"}
    tag = await _load_org_tag(ctx, tag_id)
    if tag is None:
        return {"error": "tag not found"}

    run_mode = params.get("run_mode") or "manual"
    if run_mode not in ("manual", "custom_range"):
        run_mode = "manual"
    tag_name = tag.get("name")
    return {
        "proposal_type": "generate_tag_report",
        "title": f"Generate Tag Report for \"{tag_name}\""[:60] if tag_name else "Generate Tag Report",
        "description": "Generate a fresh cross-survey Tag Report for this tag's surveys.",
        "requires_confirmation": True,
        "params": {
            "tag_id":       tag_id,
            "run_mode":     run_mode,
            "window_start": params.get("window_start"),
            "window_end":   params.get("window_end"),
        },
        "cta_label": "Generate Tag Report",
        "business_rationale": (
            "Rolls up already-generated per-survey insights into one trust-weighted "
            "cross-survey view — no fresh AI generation, just aggregation."
        )[:159],
    }


# ── Tool dispatch table ───────────────────────────────────────────────────────

TOOL_EXECUTORS: dict[str, Any] = {
    # Data tools
    "get_survey_overview":      execute_get_survey_overview,
    "get_topic_details":        execute_get_topic_details,
    "get_metric_history":       execute_get_metric_history,
    "get_insights_list":        execute_get_insights_list,
    "get_verbatims":            execute_get_verbatims,
    "get_benchmark_comparison": execute_get_benchmark_comparison,
    "get_driver_analysis":      execute_get_driver_analysis,
    "get_segment_breakdown":    execute_get_segment_breakdown,
    "list_segmentable_questions": execute_list_segmentable_questions,
    "get_checkpoint_history":   execute_get_checkpoint_history,
    "get_recent_checkpoints":   execute_get_recent_checkpoints,
    # Insight Pipeline v2 — checkpoint chain / trail / report tools
    "get_checkpoint_chain":     execute_get_checkpoint_chain,
    "get_insight_settings":     execute_get_insight_settings,
    "get_insight_report":       execute_get_insight_report,
    "get_insight_trail":        execute_get_insight_trail,
    "get_checkpoint_detail":    execute_get_checkpoint_detail,
    "compare_checkpoints":      execute_compare_checkpoints,
    "compare_surveys":          execute_compare_surveys,
    "get_org_portfolio":        execute_get_org_portfolio,
    "get_cross_survey_themes":  execute_get_cross_survey_themes,
    "get_anomaly_events":       execute_get_anomaly_events,
    # Analytical-skill tools
    "summarize_themes":         execute_summarize_themes,
    "analyze_trends_over_time": execute_analyze_trends_over_time,
    "analyze_segments":         execute_analyze_segments,
    "analyze_key_drivers":      execute_analyze_key_drivers,
    "proactive_insights":       execute_proactive_insights,
    "generate_report":          execute_generate_report,
    # Action proposal tools
    "recommend_next_actions":   execute_recommend_next_actions,
    "propose_survey_creation":  execute_propose_survey_creation,
    "propose_survey_edit":      execute_propose_survey_edit,
    "propose_distribution":     execute_propose_distribution,
    "propose_workflow":         execute_propose_workflow,
    "propose_alert":            execute_propose_alert,
    # Insight Pipeline v2 — report action proposals
    "propose_manual_insight_run":            execute_propose_manual_insight_run,
    "propose_view_report":                   execute_propose_view_report,
    "propose_generate_intelligence_report":  execute_propose_generate_intelligence_report,
    "list_relevant_templates":  execute_list_relevant_templates,
    # User-directory segmentation tools
    **USER_DIRECTORY_EXECUTORS,
    # Group / survey-tag tools (cross-survey intelligence)
    "get_group_surveys":      execute_get_group_surveys,
    "get_group_metrics":      execute_get_group_metrics,
    "get_group_topics":       execute_get_group_topics,
    "analyze_group_coverage": execute_analyze_group_coverage,
    "detect_data_gaps":       execute_detect_data_gaps,
    "suggest_new_survey":     execute_suggest_new_survey,
    # Tag Report tools (cross-survey trust-weighted rollup)
    "list_tags":                     execute_list_tags,
    "get_tag_report":                execute_get_tag_report,
    "get_tag_report_trail":          execute_get_tag_report_trail,
    "propose_view_tag_report":       execute_propose_view_tag_report,
    "propose_generate_tag_report":   execute_propose_generate_tag_report,
    # Tier 3 data tools
    "get_contact_identity":    execute_get_contact_identity,
    "get_ownership_route":     execute_get_ownership_route,
    "get_ontology_context":    execute_get_ontology_context,
    "get_xo_context":          execute_get_xo_context,
    "get_case_history":        execute_get_case_history,
    # Tier 3 action proposal tools
    "propose_create_case":     execute_propose_create_case,
    "propose_assign_owner":    execute_propose_assign_owner,
    "propose_slack_alert":     execute_propose_slack_alert,
    # Support tools (crystal-support skill)
    "search_support_docs":     execute_search_support_docs,
    "get_doc_by_key":          execute_get_doc_by_key,
    "get_feature_status":      execute_get_feature_status,
    "get_account_state":       execute_get_account_state,
    "get_known_issues":        execute_get_known_issues,
    "get_system_status":       execute_get_system_status,
    "create_support_ticket":   execute_create_support_ticket,
    "get_changelog_recent":    execute_get_changelog_recent,
}


async def dispatch_tool(tool_name: str, ctx: CrystalContext, params: dict) -> dict:
    """Dispatch a tool call to the appropriate executor.

    Always returns a dict — never raises. Matches the contract already
    guaranteed by `lib/tool_dispatcher.py::ToolDispatcher.dispatch()`:
    on executor failure, returns `{"error": str(exc), "tool": tool_name}`
    instead of letting the exception propagate.
    """
    executor = TOOL_EXECUTORS.get(tool_name)
    if not executor:
        return {"error": f"Unknown tool: {tool_name}"}

    start = _time.monotonic()
    try:
        try:
            result = await executor(ctx, params)
        except Exception as exc:
            logger.error(
                "tool_dispatch_error",
                tool=tool_name,
                error=str(exc),
                traceback=traceback.format_exc(),
            )
            return {"error": str(exc), "tool": tool_name}
        crystal_tool_calls_total.labels(tool=tool_name, org_id=ctx.org_id or "unknown").inc()
        return result
    finally:
        duration = _time.monotonic() - start
        crystal_tool_duration_seconds.labels(tool=tool_name).observe(duration)
