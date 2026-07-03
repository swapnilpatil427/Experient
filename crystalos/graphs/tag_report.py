"""Tag Report — cross-survey checkpoint rollup pipeline.

Rolls up EXISTING per-survey AI insight checkpoints (``insight_checkpoints_v2``,
written by the separate single-survey pipeline in ``graphs/insights.py``) across
every survey sharing a tag, into one cross-survey report. This graph NEVER
generates fresh per-survey AI insight — it only reads and synthesizes checkpoints
that already exist. See docs/tag-report/DESIGN.md §2 (Non-Goals) and
docs/tag-report/TRACKER.md §2 (full node-by-node design, authoritative).

Layer boundary (TRACKER.md reconciliation item 7): the Node backend resolves
``effective_max_surveys`` (3-tier COALESCE settings merge) and hands off
``{run_id, org_id, tag_id, run_mode, window_start, window_end, effective_max_surveys}``.
This graph owns everything downstream of that: recency-ordered survey candidate
fetching, checkpoint bracket/nearest-checkpoint resolution, backfill looping,
gating, merge, narrate, publish.

Pipeline shape — NOT a linear DAG like ``group_insights.py``. The batch-resolution
phase is a LangGraph cycle:

    fetch_next_batch -> resolve_and_gate_batch -> (loop back | proceed)

looping until target-N surveys are included, the ceiling is hit, or the tag's
survey pool is exhausted. Everything after the loop is a straight pipeline:

    compute_bracket_delta -> apply_trend_eligibility_gate -> merge_metric_tracks
        -> check_cross_track_corroboration -> detect_comparability_warnings
        -> narrate_tag_report -> merge_citation_manifest -> publish

Cost invariant (hard architectural requirement, TRACKER.md §2 "Cost accounting"):
``llm_call_count == len(qualifying metric tracks)`` — O(1)-O(3), NEVER O(N)
regardless of how many surveys were scanned. Every checkpoint read, bracket
delta, gate, and merge computation above is pure SQL + Python; the LLM is
invoked exactly once per qualifying metric track in ``narrate_tag_report``.
"""
from __future__ import annotations

import json
import math
import os
import traceback as _tb
import uuid
from datetime import datetime, timezone
from typing import Any, TypedDict

from langgraph.graph import StateGraph

from crystalos.lib import db
from crystalos.lib.logger import logger
from crystalos.tools.delta import compute_delta, compute_topic_lifecycle

METRIC_KEYS: tuple[str, ...] = ("nps", "csat", "ces")

# ── Tunables ───────────────────────────────────────────────────────────────────
# Kept local to this module (rather than crystalos/lib/constants.py, where
# TRACKER.md §2 task 1 suggests tunables normally live) to keep this feature's
# changes scoped to its own new files during implementation. Same env-override
# convention as lib/constants.py for consistency; promote to lib/constants.py
# in a follow-up if/when other modules need to read these too.
TAG_REPORT_DEFAULT_TARGET_N:         int = int(os.getenv("TAG_REPORT_DEFAULT_TARGET_N",         "5"))
TAG_REPORT_CEILING_N:                int = int(os.getenv("TAG_REPORT_CEILING_N",                "20"))
TAG_REPORT_BATCH_SIZE:               int = int(os.getenv("TAG_REPORT_BATCH_SIZE",               "3"))
TAG_REPORT_MIN_RESPONSE_COUNT:       int = int(os.getenv("TAG_REPORT_MIN_RESPONSE_COUNT",       "30"))
TAG_REPORT_MIN_TRUST_SCORE:          int = int(os.getenv("TAG_REPORT_MIN_TRUST_SCORE",          "40"))
TAG_REPORT_AGREEMENT_FLOOR:          int = int(os.getenv("TAG_REPORT_AGREEMENT_FLOOR",          "2"))
TAG_REPORT_STALENESS_THRESHOLD_DAYS: int = int(os.getenv("TAG_REPORT_STALENESS_THRESHOLD_DAYS", "21"))


# ── State shape ────────────────────────────────────────────────────────────────

class TagReportState(TypedDict, total=False):
    org_id:         str
    run_id:         str
    tag_id:         str
    report_mode:    str                 # 'manual' | 'automated' | 'custom_range'
    window_start:   str | None
    window_end:     str | None

    target_n:       int
    ceiling_n:      int
    batch_size:     int

    candidate_pool: list[dict]          # full ordered candidate pool, fetched once
    current_batch:  list[dict]          # this iteration's batch
    cursor:         int                 # index into candidate_pool already scanned
    loop_iterations: int
    loop_stop_reason: str

    included_surveys: list[dict]        # {survey_id, title, trend_eligible, response_count, ...}
    excluded_surveys: list[dict]        # {survey_id, reason, detail}

    boundary_checkpoints: dict[str, Any]  # survey_id -> {"single": ckpt} | {"start","end","same_checkpoint"}
    bracket_deltas:        dict[str, Any]  # survey_id -> compute_delta() output | None
    bracket_topic_lifecycle: dict[str, Any]

    metric_tracks:  dict[str, Any]      # metric_key -> {eligible, eligible_survey_ids, ...}
    merge_votes:    list[dict]
    corroboration_signals:    list[dict]
    comparability_warnings:   list[dict]

    narrated_tracks: dict[str, Any]     # metric_key -> {headline, narrative, ...}
    llm_call_count:  int
    citation_manifest: list[dict]

    stream_events:  list[dict]
    errors:         list[str]


# ── Small pure helpers ───────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _event(run_id: str, event_type: str, **kwargs) -> dict:
    """Common event envelope per TRACKER.md §2's streaming event contract:
    {"event", "ts", "run_id", ...}. Field names/vocabulary here are a locked
    cross-team contract — Jordan's frontend visualization is built against
    this exact vocabulary. Do not rename fields."""
    return {"event": event_type, "ts": _now_iso(), "run_id": run_id, **kwargs}


def _parse_dt(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        s = str(value)
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _offset_days(requested_iso: str | None, actual: Any) -> float | None:
    """Signed offset in days: actual checkpoint date minus requested boundary."""
    req = _parse_dt(requested_iso)
    act = _parse_dt(actual)
    if req is None or act is None:
        return None
    return round((act - req).total_seconds() / 86400.0, 4)


def _direction(value: float | None) -> str:
    """Vote direction for a metric delta. 'none' = no value (not comparable);
    'flat' = a real, exact-zero delta (distinct from 'no data')."""
    if value is None:
        return "none"
    if value > 0:
        return "up"
    if value < 0:
        return "down"
    return "flat"


def _metric_delta_value(delta: dict | None, metric_key: str) -> float | None:
    if not delta:
        return None
    return delta.get(f"{metric_key}_delta")


def _survey_has_metric(checkpoint: dict | None, metric_key: str) -> bool:
    if not checkpoint:
        return False
    return checkpoint.get(f"{metric_key}_at_checkpoint") is not None


def _trust_statistical(n: int) -> int:
    """Sample-size -> statistical trust score (0-100).

    Reimplements ``graphs.insights._trust_statistical`` exactly (same formula,
    same thresholds) rather than importing a name prefixed ``_`` across module
    boundaries. ``insight_checkpoints_v2`` has no stored ``trust_score`` column
    (confirmed against the live migration — see TRACKER.md §2's checkpoint-table
    reconciliation note), so Tag Report derives a per-checkpoint trust-weight
    proxy from response count using the platform's one existing statistical-trust
    formula, rather than inventing a second one. Documented as an implementation
    decision in the CrystalOS hand-off notes.
    """
    if n >= 100:
        return 90
    if n >= 50:
        return 80
    if n >= 30:
        return 70
    return max(10, round(10 + (n / 30.0) * 60))


_SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2, "severe": 3}


def compute_temporal_offset_tier(
    requested_span_days: float,
    start_offset_days: float,
    end_offset_days: float,
) -> tuple[str, float]:
    """DESIGN.md R-C2's final, twice-corrected 3-zone confidence-tiering formula.

    Implemented exactly as specified (do not "simplify" — the design doc notes
    two prior versions each had a confirmed bug):

      - requested_span_days < 10:  tier by ABSOLUTE total offset in days only.
            <=1 high, <=3 medium, <=7 low, >7 severe
      - requested_span_days >= 18: tier by the RATIO
            (start_offset_days + end_offset_days) / requested_span_days only.
            <=0.1 high, <=0.5 medium, <=1.0 low, >1.0 severe
      - 10 <= requested_span_days < 18 (blend zone): compute BOTH the absolute
            and ratio tiers, and use whichever is MORE SEVERE (stricter). This
            zone exists because a hard cutover at any single boundary produces a
            confirmed inversion bug: a narrower window with the same absolute
            offset could score a *better* tier than a wider window with the
            identical offset.

    Returns (confidence_tier, distortion_score). In the absolute zone,
    distortion_score is the total absolute offset (days); in the ratio and
    blend zones it's the ratio (the canonical, span-normalized distortion unit).
    """
    total_offset = abs(start_offset_days) + abs(end_offset_days)
    ratio = (total_offset / requested_span_days) if requested_span_days > 0 else float("inf")

    def _absolute_tier(offset: float) -> str:
        if offset <= 1:
            return "high"
        if offset <= 3:
            return "medium"
        if offset <= 7:
            return "low"
        return "severe"

    def _ratio_tier(r: float) -> str:
        if r <= 0.1:
            return "high"
        if r <= 0.5:
            return "medium"
        if r <= 1.0:
            return "low"
        return "severe"

    if requested_span_days < 10:
        return _absolute_tier(total_offset), total_offset
    if requested_span_days >= 18:
        return _ratio_tier(ratio), ratio

    # Blend zone: stricter (more severe) of the two.
    abs_tier = _absolute_tier(total_offset)
    ratio_tier = _ratio_tier(ratio)
    tier = abs_tier if _SEVERITY_ORDER[abs_tier] >= _SEVERITY_ORDER[ratio_tier] else ratio_tier
    return tier, ratio


def _compute_loop_decision(
    *, included_count: int, cursor: int, pool_size: int, target_n: int, ceiling_n: int,
) -> str:
    """Single source of truth for the batch-resolution cycle's three exits
    (target_reached / ceiling_hit / pool_exhausted) or 'continue'. Shared by
    the node (to emit batch_loop_resolved) and the conditional-edge router (to
    actually route) so they can never disagree."""
    if included_count >= target_n:
        return "target_reached"
    if cursor >= ceiling_n:
        return "ceiling_hit"
    if cursor >= pool_size:
        return "pool_exhausted"
    return "continue"


# ── Checkpoint resolution (reusable library function — TRACKER.md §2 task 3) ──

def _normalize_checkpoint_row(row: dict) -> dict:
    row = dict(row)
    if row.get("id") is not None:
        row["id"] = str(row["id"])
    if row.get("created_at") is not None:
        row["created_at"] = str(row["created_at"])
    for key in ("nps_at_checkpoint", "csat_at_checkpoint", "ces_at_checkpoint"):
        if row.get(key) is not None:
            try:
                row[key] = float(row[key])
            except (TypeError, ValueError):
                pass
    return row


async def _fetch_latest_checkpoint(survey_id: str, org_id: str) -> dict | None:
    """Most recent insight_checkpoints_v2 row for a survey, across both lanes.

    No status filter: insight_checkpoints_v2 has no status column at all — rows
    are written exactly once, atomically, at publish (_write_checkpoint_v2), so
    any row that exists is by construction ready. Served by the existing index
    idx_ckpt_v2_survey_created (survey_id, org_id, created_at DESC).
    """
    async with db._pool_conn().connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT * FROM insight_checkpoints_v2
                   WHERE survey_id = %s AND org_id = %s
                   ORDER BY created_at DESC LIMIT 1""",
                (survey_id, org_id),
            )
            row = await cur.fetchone()
            if not row:
                return None
            cols = [d[0] for d in cur.description]
            return _normalize_checkpoint_row(dict(zip(cols, row)))


async def _fetch_checkpoint_at_or_before(survey_id: str, org_id: str, boundary: str) -> dict | None:
    """Nearest checkpoint at-or-before ``boundary`` (Bracketed Snapshot, R-C1)."""
    async with db._pool_conn().connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT * FROM insight_checkpoints_v2
                   WHERE survey_id = %s AND org_id = %s AND created_at <= %s
                   ORDER BY created_at DESC LIMIT 1""",
                (survey_id, org_id, boundary),
            )
            row = await cur.fetchone()
            if not row:
                return None
            cols = [d[0] for d in cur.description]
            return _normalize_checkpoint_row(dict(zip(cols, row)))


_METRIC_SCALE_DEFAULTS: dict[str, tuple[float, float]] = {
    # Platform-conventional canonical scales — used whenever a question of this
    # exact type carries no more specific scale field of its own.
    "nps": (0.0, 10.0),
    "csat": (1.0, 5.0),
    "ces": (1.0, 7.0),
}


def _question_scale_for_metric(question: dict) -> tuple[float, float] | None:
    """Effective numeric scale (min, max) for a survey question, when it's
    relevant to a metric comparison. Returns None for question shapes with no
    determinable numeric scale (should not happen for the types this is called
    with, but defensive rather than raising)."""
    qtype = question.get("type")
    if qtype in ("nps", "csat", "ces"):
        return _METRIC_SCALE_DEFAULTS[qtype]
    if qtype == "rating":
        scale_max = question.get("scaleMax")
        try:
            return (1.0, float(scale_max) if scale_max is not None else 5.0)
        except (TypeError, ValueError):
            return (1.0, 5.0)
    if qtype == "slider":
        try:
            lo = float(question.get("min")) if question.get("min") is not None else 0.0
            hi = float(question.get("max")) if question.get("max") is not None else 100.0
            return (lo, hi)
        except (TypeError, ValueError):
            return (0.0, 100.0)
    return None


def _find_metric_question(questions: list, metric_key: str) -> dict | None:
    """Find the question on a survey that measures ``metric_key``. Prefers an
    exact-type match (a real 'nps'/'csat'/'ces' question); CES in particular is
    commonly authored as a plain 'rating' question since there is no dedicated
    CES question-builder UI, so a generic rating question is accepted as a
    fallback proxy for csat/ces (never for nps, which has no such ambiguity)."""
    if not isinstance(questions, list):
        return None
    for q in questions:
        if isinstance(q, dict) and q.get("type") == metric_key:
            return q
    if metric_key in ("csat", "ces"):
        for q in questions:
            if isinstance(q, dict) and q.get("type") == "rating":
                return q
    return None


async def _fetch_survey_questions(survey_ids: list[str], org_id: str) -> dict[str, list]:
    """Batch-fetch {survey_id: questions[]} for comparability checks. Never
    raises — returns {} on any failure so a lookup failure degrades to "no
    warning" rather than failing the whole run."""
    if not survey_ids:
        return {}
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT id, questions FROM surveys WHERE id = ANY(%s::uuid[]) AND org_id = %s",
                    (survey_ids, org_id),
                )
                rows = await cur.fetchall()
    except Exception as exc:
        logger.debug("tag_report_survey_questions_fetch_failed", error=str(exc))
        return {}
    out: dict[str, list] = {}
    for sid, questions in rows:
        out[str(sid)] = questions if isinstance(questions, list) else (json.loads(questions) if questions else [])
    return out


TAG_REPORT_CADENCE_MISMATCH_RATIO: float = float(os.getenv("TAG_REPORT_CADENCE_MISMATCH_RATIO", "2.0"))


async def _fetch_checkpoint_cadence_days(survey_id: str, org_id: str) -> float | None:
    """Median interval (days) between a survey's own recent checkpoints — a
    proxy for how frequently it runs. None when fewer than 2 checkpoints exist
    (cadence isn't determinable yet). Never raises."""
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT created_at FROM insight_checkpoints_v2
                       WHERE survey_id = %s AND org_id = %s
                       ORDER BY created_at DESC LIMIT 6""",
                    (survey_id, org_id),
                )
                rows = await cur.fetchall()
    except Exception as exc:
        logger.debug("tag_report_cadence_fetch_failed", survey_id=survey_id, error=str(exc))
        return None
    timestamps = sorted((_parse_dt(r[0]) for r in rows if _parse_dt(r[0]) is not None), reverse=True)
    if len(timestamps) < 2:
        return None
    gaps = [(timestamps[i] - timestamps[i + 1]).total_seconds() / 86400.0 for i in range(len(timestamps) - 1)]
    gaps.sort()
    mid = len(gaps) // 2
    return gaps[mid] if len(gaps) % 2 else (gaps[mid - 1] + gaps[mid]) / 2


async def detect_metric_comparability_mismatches(
    metric_key: str, eligible_survey_ids: list[str], org_id: str,
) -> list[dict]:
    """R-T3 — cadence, scale, and question-type comparability checks, scoped to
    one metric's contributing surveys. Returns warning dicts (not yet wrapped in
    an _event) so the caller can both collect and emit them. Never raises — any
    lookup failure yields fewer warnings, never a run failure, matching this
    graph's house style of degrading gracefully around optional signals."""
    warnings: list[dict] = []
    if len(eligible_survey_ids) < 2:
        return warnings  # nothing to compare across a single survey

    questions_by_survey = await _fetch_survey_questions(eligible_survey_ids, org_id)

    # ── Scale + question-type mismatch ──────────────────────────────────────
    types_by_survey: dict[str, str] = {}
    scales_by_survey: dict[str, tuple[float, float]] = {}
    for sid in eligible_survey_ids:
        q = _find_metric_question(questions_by_survey.get(sid) or [], metric_key)
        if q is None:
            continue
        types_by_survey[sid] = q.get("type")
        scale = _question_scale_for_metric(q)
        if scale is not None:
            scales_by_survey[sid] = scale

    distinct_types = set(types_by_survey.values())
    if len(distinct_types) > 1:
        warnings.append({
            "scope": "metric", "warning_type": "question_type_mismatch",
            "distortion_score": float(len(distinct_types)),
            "confidence_tier": "medium",
            "affected_survey_ids": sorted(types_by_survey.keys()),
            "metric_key": metric_key,
        })

    distinct_scales = set(scales_by_survey.values())
    if len(distinct_scales) > 1:
        # Severity scales with how different the widest two ranges are relative
        # to each other — a 1-5 vs 1-7 mismatch is milder than 0-10 vs 1-5.
        spans = sorted((hi - lo) for lo, hi in distinct_scales)
        ratio = spans[-1] / spans[0] if spans[0] > 0 else float("inf")
        tier = "severe" if ratio >= 2.0 else ("medium" if ratio >= 1.3 else "low")
        warnings.append({
            "scope": "metric", "warning_type": "scale_mismatch",
            "distortion_score": round(ratio, 4),
            "confidence_tier": tier,
            "affected_survey_ids": sorted(scales_by_survey.keys()),
            "metric_key": metric_key,
        })

    # ── Cadence mismatch ─────────────────────────────────────────────────────
    cadences: dict[str, float] = {}
    for sid in eligible_survey_ids:
        days = await _fetch_checkpoint_cadence_days(sid, org_id)
        if days is not None and days > 0:
            cadences[sid] = days

    if len(cadences) >= 2:
        values = sorted(cadences.values())
        ratio = values[-1] / values[0] if values[0] > 0 else float("inf")
        if ratio >= TAG_REPORT_CADENCE_MISMATCH_RATIO:
            warnings.append({
                "scope": "metric", "warning_type": "cadence_mismatch",
                "distortion_score": round(ratio, 4),
                "confidence_tier": "medium" if ratio < TAG_REPORT_CADENCE_MISMATCH_RATIO * 1.5 else "severe",
                "affected_survey_ids": sorted(cadences.keys()),
                "metric_key": metric_key,
            })

    return warnings


async def resolve_boundary_checkpoints(
    survey_id: str, org_id: str, report_mode: str,
    window_start: str | None, window_end: str | None,
) -> dict:
    """Resolve the checkpoint(s) needed for one survey.

    Manual/Automated -> ``{"single": ckpt | None}`` (latest checkpoint).
    Custom Range     -> ``{"start": ckpt | None, "end": ckpt | None}``
                        (nearest-at-or-before each window boundary, independently).
    """
    if report_mode == "custom_range":
        start_ckpt = await _fetch_checkpoint_at_or_before(survey_id, org_id, window_start)
        end_ckpt = await _fetch_checkpoint_at_or_before(survey_id, org_id, window_end)
        return {"start": start_ckpt, "end": end_ckpt}
    ckpt = await _fetch_latest_checkpoint(survey_id, org_id)
    return {"single": ckpt}


# ── Node 1: fetch_next_batch (loop entry/re-entry) ────────────────────────────

async def node_fetch_next_batch(state: TagReportState) -> dict:
    org_id = state["org_id"]
    tag_id = state["tag_id"]
    run_id = state["run_id"]
    events = list(state.get("stream_events") or [])
    errors = list(state.get("errors") or [])
    cursor = state.get("cursor", 0)
    batch_size = state.get("batch_size") or TAG_REPORT_BATCH_SIZE
    loop_iterations = state.get("loop_iterations", 0) + 1
    pool = state.get("candidate_pool")

    if pool is None:
        try:
            async with db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """SELECT s.id, s.title, s.created_at
                           FROM surveys s
                           JOIN survey_tag_mappings m ON m.survey_id = s.id
                           WHERE m.tag_id = %s AND m.org_id = %s
                             AND s.org_id = %s AND s.deleted_at IS NULL
                           ORDER BY s.created_at DESC""",
                        (tag_id, org_id, org_id),
                    )
                    rows = await cur.fetchall()
                    cols = [d[0] for d in cur.description]
            pool = []
            for r in rows:
                row = dict(zip(cols, r))
                row["id"] = str(row["id"])
                if row.get("created_at") is not None:
                    row["created_at"] = str(row["created_at"])
                pool.append(row)
        except Exception as exc:
            errors.append(f"fetch_next_batch: {exc}")
            logger.error("tag_report_fetch_batch_failed", run_id=run_id, error=str(exc))
            pool = []

    batch = pool[cursor: cursor + batch_size]
    new_cursor = cursor + len(batch)

    events.append(_event(run_id, "batch_fetched", batch_index=loop_iterations - 1,
                          survey_ids=[b["id"] for b in batch], cursor=new_cursor, pool_size=len(pool)))
    for i, b in enumerate(batch):
        events.append(_event(run_id, "survey_selected", survey_id=b["id"], position=cursor + i,
                              title=b.get("title"), created_at=b.get("created_at")))

    return {
        "candidate_pool": pool,
        "cursor": new_cursor,
        "loop_iterations": loop_iterations,
        "current_batch": batch,
        "stream_events": events,
        "errors": errors,
    }


# ── Node 2: resolve_and_gate_batch (loop body) ────────────────────────────────

async def node_resolve_and_gate_batch(state: TagReportState) -> dict:
    org_id = state["org_id"]
    run_id = state["run_id"]
    report_mode = state.get("report_mode", "manual")
    window_start = state.get("window_start")
    window_end = state.get("window_end")
    batch = state.get("current_batch") or []
    included = list(state.get("included_surveys") or [])
    excluded = list(state.get("excluded_surveys") or [])
    boundary_checkpoints = dict(state.get("boundary_checkpoints") or {})
    events = list(state.get("stream_events") or [])
    errors = list(state.get("errors") or [])

    min_response_count = TAG_REPORT_MIN_RESPONSE_COUNT
    min_trust_score = TAG_REPORT_MIN_TRUST_SCORE

    req_start_dt = _parse_dt(window_start)
    req_end_dt = _parse_dt(window_end)
    requested_span_days = (
        (req_end_dt - req_start_dt).total_seconds() / 86400.0
        if req_start_dt and req_end_dt else 0.0
    )

    for survey in batch:
        sid = survey["id"]
        try:
            resolved = await resolve_boundary_checkpoints(sid, org_id, report_mode, window_start, window_end)
        except Exception as exc:
            errors.append(f"resolve_and_gate_batch:{sid}: {exc}")
            logger.error("tag_report_resolve_checkpoint_failed", run_id=run_id, survey_id=sid, error=str(exc))
            resolved = {"start": None, "end": None} if report_mode == "custom_range" else {"single": None}

        if report_mode == "custom_range":
            start_ckpt = resolved.get("start")
            end_ckpt = resolved.get("end")
            if start_ckpt is None:
                excluded.append({"survey_id": sid, "reason": "no_checkpoint_in_range",
                                  "detail": "no checkpoint before window start"})
                events.append(_event(run_id, "survey_excluded", survey_id=sid,
                                      reason="no_checkpoint_in_range",
                                      detail="no checkpoint before window start"))
                continue

            end_for_gate = end_ckpt or start_ckpt
            same_checkpoint = str(end_for_gate.get("id")) == str(start_ckpt.get("id"))

            offset_start = _offset_days(window_start, start_ckpt.get("created_at")) or 0.0
            offset_end = _offset_days(window_end, end_for_gate.get("created_at")) or 0.0
            tier, distortion_score = compute_temporal_offset_tier(requested_span_days, offset_start, offset_end)

            rc_start = int(start_ckpt.get("response_count_at_checkpoint") or 0)
            rc_end = int(end_for_gate.get("response_count_at_checkpoint") or 0)
            trust_start = _trust_statistical(rc_start)
            trust_end = _trust_statistical(rc_end)

            # R-C3: baseline AND latest must each independently clear Gate 1.
            # A 'severe' temporal-offset tier also excludes the survey from trend
            # voting (R-C2: ">7d severe — excluded from stated trend numbers,
            # descriptive-only") — computed here (not in detect_comparability_
            # warnings) so the merge stage that runs later in this same pass sees
            # a single, consistent eligibility decision rather than one node
            # setting it and a later node retroactively invalidating an
            # already-computed merge.
            trend_eligible = (
                not same_checkpoint
                and rc_start >= min_response_count and rc_end >= min_response_count
                and trust_start >= min_trust_score and trust_end >= min_trust_score
                and tier != "severe"
            )

            boundary_checkpoints[sid] = {
                "start": start_ckpt, "end": end_for_gate, "same_checkpoint": same_checkpoint,
            }
            included.append({
                "survey_id": sid, "title": survey.get("title"),
                "trend_eligible": trend_eligible,
                "response_count": rc_end,
                "bracket_position": "start_end",
                "offset_start_days": offset_start,
                "offset_end_days": offset_end,
                "same_checkpoint": same_checkpoint,
                "temporal_offset_tier": tier,
                "temporal_distortion_score": distortion_score,
            })
            events.append(_event(run_id, "checkpoint_resolved", survey_id=sid, bracket_position="start",
                                  checkpoint_date=start_ckpt.get("created_at"), offset_days=offset_start))
            events.append(_event(run_id, "checkpoint_resolved", survey_id=sid, bracket_position="end",
                                  checkpoint_date=end_for_gate.get("created_at"), offset_days=offset_end))

        else:
            ckpt = resolved.get("single")
            if ckpt is None:
                excluded.append({"survey_id": sid, "reason": "no_checkpoint_in_range",
                                  "detail": "no checkpoint available"})
                events.append(_event(run_id, "survey_excluded", survey_id=sid,
                                      reason="no_checkpoint_in_range", detail="no checkpoint available"))
                continue

            rc = int(ckpt.get("response_count_at_checkpoint") or 0)
            trust_score = _trust_statistical(rc)
            trend_eligible = rc >= min_response_count and trust_score >= min_trust_score

            boundary_checkpoints[sid] = {"single": ckpt}
            included.append({
                "survey_id": sid, "title": survey.get("title"),
                "trend_eligible": trend_eligible, "response_count": rc,
                "bracket_position": "single",
            })
            events.append(_event(run_id, "checkpoint_resolved", survey_id=sid, bracket_position="single",
                                  checkpoint_date=ckpt.get("created_at"), offset_days=0))

    target_n = state.get("target_n", TAG_REPORT_DEFAULT_TARGET_N)
    ceiling_n = state.get("ceiling_n", TAG_REPORT_CEILING_N)
    cursor = state.get("cursor", 0)
    pool_size = len(state.get("candidate_pool") or [])
    decision = _compute_loop_decision(
        included_count=len(included), cursor=cursor, pool_size=pool_size,
        target_n=target_n, ceiling_n=ceiling_n,
    )
    if decision != "continue":
        events.append(_event(run_id, "batch_loop_resolved",
                              included_count=len(included), target_n=target_n, loop_stop_reason=decision))

    return {
        "included_surveys": included, "excluded_surveys": excluded,
        "boundary_checkpoints": boundary_checkpoints,
        "loop_stop_reason": decision,
        "stream_events": events, "errors": errors,
    }


def _route_after_gate(state: TagReportState) -> str:
    """Conditional-edge router. Re-derives the same decision node 2 already
    computed (and emitted an event for) via the shared helper — never routes
    on a value the emitted event didn't also reflect."""
    target_n = state.get("target_n", TAG_REPORT_DEFAULT_TARGET_N)
    ceiling_n = state.get("ceiling_n", TAG_REPORT_CEILING_N)
    included_count = len(state.get("included_surveys") or [])
    cursor = state.get("cursor", 0)
    pool_size = len(state.get("candidate_pool") or [])
    return _compute_loop_decision(
        included_count=included_count, cursor=cursor, pool_size=pool_size,
        target_n=target_n, ceiling_n=ceiling_n,
    )


# ── Node 3: compute_bracket_delta ─────────────────────────────────────────────

async def node_compute_bracket_delta(state: TagReportState) -> dict:
    report_mode = state.get("report_mode", "manual")
    run_id = state["run_id"]
    boundary_checkpoints = state.get("boundary_checkpoints") or {}
    events = list(state.get("stream_events") or [])
    bracket_deltas: dict[str, Any] = {}
    bracket_topic_lifecycle: dict[str, Any] = {}

    for sid, ckpts in boundary_checkpoints.items():
        if report_mode == "custom_range":
            start_ckpt = ckpts.get("start")
            end_ckpt = ckpts.get("end")
            if not start_ckpt or not end_ckpt:
                bracket_deltas[sid] = None
                continue
            if ckpts.get("same_checkpoint"):
                # R-C1: only one checkpoint exists near the requested window —
                # a flat snapshot, explicitly NOT a "0% change" trend claim.
                bracket_deltas[sid] = {
                    "no_comparison_available": True,
                    "nps_delta": None, "csat_delta": None, "ces_delta": None,
                }
                continue
            delta = compute_delta(end_ckpt, start_ckpt)
            bracket_deltas[sid] = delta
            bracket_topic_lifecycle[sid] = compute_topic_lifecycle(
                start_ckpt.get("topics") or [], end_ckpt.get("topics") or [],
            )
            events.append(_event(run_id, "bracket_delta_computed", survey_id=sid,
                                  nps_delta=delta.get("nps_delta"), csat_delta=delta.get("csat_delta"),
                                  ces_delta=delta.get("ces_delta"),
                                  start_checkpoint_id=str(start_ckpt.get("id")),
                                  end_checkpoint_id=str(end_ckpt.get("id"))))
        else:
            ckpt = ckpts.get("single")
            if not ckpt:
                bracket_deltas[sid] = None
                continue
            # Rolling window (Manual/Automated): pass through the delta already
            # computed by the per-survey pipeline at checkpoint-write time —
            # never recompute it here.
            raw_delta = ckpt.get("delta_from_prior")
            if isinstance(raw_delta, str):
                try:
                    raw_delta = json.loads(raw_delta)
                except (TypeError, ValueError):
                    raw_delta = None
            bracket_deltas[sid] = raw_delta
            events.append(_event(run_id, "bracket_delta_computed", survey_id=sid,
                                  nps_delta=(raw_delta or {}).get("nps_delta"),
                                  csat_delta=(raw_delta or {}).get("csat_delta"),
                                  ces_delta=(raw_delta or {}).get("ces_delta"),
                                  start_checkpoint_id=None, end_checkpoint_id=str(ckpt.get("id"))))

    return {
        "bracket_deltas": bracket_deltas,
        "bracket_topic_lifecycle": bracket_topic_lifecycle,
        "stream_events": events,
    }


# ── Node 4: apply_trend_eligibility_gate ──────────────────────────────────────

async def node_apply_trend_eligibility_gate(state: TagReportState) -> dict:
    included = state.get("included_surveys") or []
    boundary_checkpoints = state.get("boundary_checkpoints") or {}
    report_mode = state.get("report_mode", "manual")
    run_id = state["run_id"]
    events = list(state.get("stream_events") or [])
    metric_tracks: dict[str, dict] = {}

    for metric_key in METRIC_KEYS:
        eligible_ids: list[str] = []
        excluded_ids: list[str] = []
        for survey in included:
            sid = survey["survey_id"]
            ckpts = boundary_checkpoints.get(sid) or {}
            ckpt_for_capability = (ckpts.get("end") or ckpts.get("start")) if report_mode == "custom_range" \
                else ckpts.get("single")
            if not _survey_has_metric(ckpt_for_capability, metric_key):
                excluded_ids.append(sid)
                continue
            if not survey.get("trend_eligible"):
                excluded_ids.append(sid)
                continue
            eligible_ids.append(sid)

        metric_tracks[metric_key] = {
            "eligible": bool(eligible_ids),
            "eligible_survey_ids": eligible_ids,
            "excluded_survey_ids": excluded_ids,
            "trend_gate_passed": len(eligible_ids) >= 1,
        }
        events.append(_event(run_id, "metric_track_gated", metric_key=metric_key,
                              eligible_survey_ids=eligible_ids, excluded_survey_ids=excluded_ids))

    return {"metric_tracks": metric_tracks, "stream_events": events}


# ── Node 5: merge_metric_tracks (trust-weighted merge) ────────────────────────

async def node_merge_metric_tracks(state: TagReportState) -> dict:
    metric_tracks = {k: dict(v) for k, v in (state.get("metric_tracks") or {}).items()}
    bracket_deltas = state.get("bracket_deltas") or {}
    included_by_id = {s["survey_id"]: s for s in (state.get("included_surveys") or [])}
    run_id = state["run_id"]
    events = list(state.get("stream_events") or [])
    merge_votes = list(state.get("merge_votes") or [])
    agreement_floor = TAG_REPORT_AGREEMENT_FLOOR

    for metric_key, track in metric_tracks.items():
        eligible_ids = track.get("eligible_survey_ids") or []
        votes = []
        for sid in eligible_ids:
            survey = included_by_id.get(sid, {})
            delta = bracket_deltas.get(sid)
            value = _metric_delta_value(delta, metric_key)
            direction = _direction(value)
            response_count = survey.get("response_count", 0)
            trust_score = _trust_statistical(response_count)
            # trust_score * log(max(response_count, 2)) — R-T2's exact weighting formula.
            weight = trust_score * math.log(max(response_count, 2))
            votes.append({
                "survey_id": sid, "direction": direction, "value": value,
                "weight": weight, "trust_score": trust_score, "response_count": response_count,
            })

        total_weight = sum(v["weight"] for v in votes) or 1.0
        for v in votes:
            normalized_weight = v["weight"] / total_weight
            merge_votes.append({**v, "metric_key": metric_key, "weight": normalized_weight})
            events.append(_event(run_id, "merge_vote", metric_key=metric_key, survey_id=v["survey_id"],
                                  weight=round(normalized_weight, 4), trust_score=v["trust_score"],
                                  response_count=v["response_count"], delta_value=v["value"]))

        direction_counts: dict[str, int] = {}
        for v in votes:
            if v["direction"] in ("up", "down"):
                direction_counts[v["direction"]] = direction_counts.get(v["direction"], 0) + 1

        if direction_counts:
            majority_direction = max(direction_counts, key=lambda d: direction_counts[d])
            agreement_count = direction_counts[majority_direction]
        else:
            majority_direction = "flat"
            agreement_count = 0

        agreeing_votes = [v for v in votes if v["direction"] == majority_direction and v["value"] is not None]
        if agreeing_votes:
            agree_weight = sum(v["weight"] for v in agreeing_votes) or 1.0
            merged_delta = sum(v["value"] * v["weight"] for v in agreeing_votes) / agree_weight
        else:
            merged_delta = None

        # R-T2 hard agreement floor: <2 agreeing trend-eligible surveys ->
        # "insufficient", excluded from a tag-wide trend claim in narration.
        # R-T2a: a tag with exactly one qualifying survey structurally can never
        # clear this floor — it still gets a single-survey-sourced descriptive
        # finding (merged_delta/single_survey_id below), never a blocked/blank card.
        confidence_tier = "insufficient" if agreement_count < agreement_floor else "confirmed"

        # single_survey_id — who to NAME in "single-survey-sourced" framing.
        # Fixed 2026-07-03 (QA finding): this previously only fired for the
        # trivial R-T2a case (exactly one eligible survey in the whole tag). The
        # general R-T2 case — "if only one trend-eligible survey supports a
        # direction[, name it]" — silently failed to name anyone whenever ≥2
        # eligible surveys existed but only one agreed on a direction (e.g. 3
        # surveys voting up/down/flat -> agreement_count=1, survey unnamed). Now
        # resolved by preferring the actual single agreeing survey (the general
        # case) and falling back to the lone-eligible-survey case (R-T2a, where
        # that survey may itself be flat/no-delta) only when there's no
        # single-agreeing-survey story to tell.
        if agreement_count == 1 and agreeing_votes:
            single_survey_id = agreeing_votes[0]["survey_id"]
        elif len(eligible_ids) == 1:
            single_survey_id = eligible_ids[0]
        else:
            single_survey_id = None

        track.update({
            "votes": votes,
            "direction": majority_direction,
            "agreement_count": agreement_count,
            "merged_delta": round(merged_delta, 2) if merged_delta is not None else None,
            "confidence_tier": confidence_tier,
            "single_survey_id": single_survey_id,
        })
        metric_tracks[metric_key] = track

        events.append(_event(run_id, "merge_resolved", metric_key=metric_key,
                              merged_delta=track["merged_delta"],
                              agreement_count=agreement_count, confidence_tier=confidence_tier))

    return {"metric_tracks": metric_tracks, "merge_votes": merge_votes, "stream_events": events}


# ── Node 6: check_cross_track_corroboration (annotation only) ────────────────

async def node_check_cross_track_corroboration(state: TagReportState) -> dict:
    metric_tracks = state.get("metric_tracks") or {}
    run_id = state["run_id"]
    events = list(state.get("stream_events") or [])
    signals = list(state.get("corroboration_signals") or [])

    keys = [k for k, t in metric_tracks.items() if t.get("trend_gate_passed") and t.get("direction") in ("up", "down")]
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            a, b = keys[i], keys[j]
            ta, tb = metric_tracks[a], metric_tracks[b]
            if ta["direction"] != tb["direction"]:
                continue
            set_a = set(ta.get("eligible_survey_ids") or [])
            set_b = set(tb.get("eligible_survey_ids") or [])
            overlap = set_a & set_b
            if not overlap:
                continue
            union = set_a | set_b
            overlap_pct = len(overlap) / len(union) if union else 0.0
            signal = {
                "tracks": [a, b], "direction": ta["direction"],
                "overlap_surveys": sorted(overlap), "window_overlap_pct": round(overlap_pct, 4),
            }
            signals.append(signal)
            events.append(_event(run_id, "corroboration_detected", **signal))

    # Annotation only — never touches metric_tracks/merged deltas.
    return {"corroboration_signals": signals, "stream_events": events}


# ── Node 7: detect_comparability_warnings ─────────────────────────────────────

async def node_detect_comparability_warnings(state: TagReportState) -> dict:
    report_mode = state.get("report_mode", "manual")
    run_id = state["run_id"]
    events = list(state.get("stream_events") or [])
    warnings = list(state.get("comparability_warnings") or [])
    included = state.get("included_surveys") or []

    if report_mode == "custom_range":
        # Emit the temporal-offset warning already tiered in resolve_and_gate_batch
        # (pure annotation here — trend_eligible was already decided there so the
        # merge stage upstream and this warning stay consistent with each other).
        for survey in included:
            if survey.get("bracket_position") != "start_end" or survey.get("same_checkpoint"):
                continue
            tier = survey.get("temporal_offset_tier")
            if tier is None:
                continue
            warning = {
                "scope": "survey", "warning_type": "temporal_offset",
                "distortion_score": round(survey.get("temporal_distortion_score") or 0.0, 4),
                "confidence_tier": tier,
                "affected_survey_ids": [survey["survey_id"]],
            }
            warnings.append(warning)
            events.append(_event(run_id, "comparability_warning", **warning))

    if report_mode == "automated":
        # R-A2: staleness is a first-class signal — a survey whose checkpoint is
        # significantly older than the median of its peers gets flagged, not
        # silently blended in with the same confidence as a fresh checkpoint.
        boundary_checkpoints = state.get("boundary_checkpoints") or {}
        ages: list[tuple[str, float]] = []
        now = datetime.now(timezone.utc)
        for survey in included:
            ckpt = (boundary_checkpoints.get(survey["survey_id"]) or {}).get("single")
            created_at = _parse_dt(ckpt.get("created_at")) if ckpt else None
            if created_at:
                ages.append((survey["survey_id"], (now - created_at).total_seconds() / 86400.0))

        if len(ages) >= 2:
            sorted_ages = sorted(a for _, a in ages)
            mid = len(sorted_ages) // 2
            median_age = (
                sorted_ages[mid] if len(sorted_ages) % 2
                else (sorted_ages[mid - 1] + sorted_ages[mid]) / 2
            )
            threshold_days = TAG_REPORT_STALENESS_THRESHOLD_DAYS
            for sid, age in ages:
                if age - median_age >= threshold_days:
                    warning = {
                        "scope": "survey", "warning_type": "staleness",
                        "distortion_score": round(age - median_age, 2),
                        "confidence_tier": "severe",
                        "affected_survey_ids": [sid],
                    }
                    warnings.append(warning)
                    events.append(_event(run_id, "comparability_warning", **warning))

    # R-T3 — cadence, scale, and question-type mismatch checks. Applies to all
    # three modes (unlike the temporal_offset/staleness checks above, which are
    # mode-specific) since two surveys can measure "the same" metric on
    # different scales/cadences regardless of how the report was triggered.
    # Added 2026-07-03 (QA finding: this was previously an unconditional no-op
    # despite DESIGN.md §4.4 declaring the full Trust Layer non-negotiable v1
    # scope) — see detect_metric_comparability_mismatches for the actual checks.
    metric_tracks = state.get("metric_tracks") or {}
    org_id = state["org_id"]
    for metric_key, track in metric_tracks.items():
        eligible_ids = track.get("eligible_survey_ids") or []
        metric_warnings = await detect_metric_comparability_mismatches(metric_key, eligible_ids, org_id)
        for warning in metric_warnings:
            warnings.append(warning)
            events.append(_event(run_id, "comparability_warning", **warning))

    return {"comparability_warnings": warnings, "stream_events": events}


# ── Node 8: narrate_tag_report (LLM, one call per qualifying metric track) ───

async def node_narrate_tag_report(state: TagReportState) -> dict:
    from pydantic import BaseModel

    from crystalos.lib.openrouter import call_agent

    class TagReportNarrativeOutput(BaseModel):
        headline: str = ""
        narrative: str = ""

    metric_tracks = state.get("metric_tracks") or {}
    run_id = state["run_id"]
    events = list(state.get("stream_events") or [])
    narrated_tracks = dict(state.get("narrated_tracks") or {})
    llm_call_count = state.get("llm_call_count", 0)
    errors = list(state.get("errors") or [])

    for metric_key, track in metric_tracks.items():
        if not track.get("eligible"):
            continue

        events.append(_event(run_id, "narration_started", metric_key=metric_key))
        try:
            notes = []
            if track.get("merged_delta") is None:
                notes.append(
                    "No trend/delta comparison is available for this metric in the "
                    "current window — describe descriptively only, never state an "
                    "up/down trend."
                )
            if track.get("confidence_tier") == "insufficient":
                notes.append(
                    "Fewer than 2 surveys agree on a direction — phrase this as a "
                    "single-survey-sourced (or insufficient-agreement) finding, "
                    "never as a tag-wide trend claim."
                )

            system = (
                "You are a senior XM analyst narrating a cross-survey Tag Report "
                "finding. You are given already-computed facts — phrase them "
                "clearly and concisely; never invent, recompute, or round a "
                "number differently than given."
            )
            user = (
                f"Metric: {metric_key}\n"
                f"Merged delta: {track.get('merged_delta')}\n"
                f"Direction: {track.get('direction')}\n"
                f"Agreement count: {track.get('agreement_count')} of "
                f"{len(track.get('eligible_survey_ids') or [])} eligible surveys\n"
                f"Confidence tier: {track.get('confidence_tier')}\n"
                + ("\n".join(notes) + "\n" if notes else "")
                + "Write a concise headline and a 2-3 sentence narrative describing this finding."
            )

            output, _ = await call_agent(
                agent_name="tag_report_narrator",
                system=system,
                user=user,
                output_schema=TagReportNarrativeOutput,
            )

            narrated_tracks[metric_key] = {
                "metric_key": metric_key,
                "headline": output.headline,
                "narrative": output.narrative,
                "confidence_tier": track.get("confidence_tier"),
                "merged_delta": track.get("merged_delta"),
                "agreement_count": track.get("agreement_count"),
                "eligible_survey_ids": track.get("eligible_survey_ids"),
            }
            llm_call_count += 1
            events.append(_event(run_id, "narration_complete", metric_key=metric_key,
                                  headline=output.headline, confidence=track.get("confidence_tier")))
        except Exception as exc:
            errors.append(f"narrate_tag_report:{metric_key}: {exc}")
            logger.error("tag_report_narrate_failed", run_id=run_id, metric_key=metric_key, error=str(exc))

    return {
        "narrated_tracks": narrated_tracks, "llm_call_count": llm_call_count,
        "stream_events": events, "errors": errors,
    }


# ── Node 9: merge_citation_manifest ───────────────────────────────────────────

TAG_REPORT_CITATIONS_PER_SURVEY: int = int(os.getenv("TAG_REPORT_CITATIONS_PER_SURVEY", "3"))


async def _fetch_real_citations_for_checkpoint(survey_id: str, run_id: Any, limit: int) -> list[dict]:
    """Resolve a checkpoint's REAL citation quotes (response_id/quote/sentiment/
    relevance), not just the manifest's response-id index.

    Corrected 2026-07-02 (integration reconciliation): the original version of
    this function only read `insight_checkpoints_v2.citations_manifest_ref`,
    whose blob (`_build_citations_manifest` in graphs/insights.py) is a lightweight
    index — `{response_ids, snapshot_ids, prior_checkpoint_refs, total_citations}`
    — with NO quote text at all. Full citation content lives on the `insights`
    table's own `citations_json` column, from the single-survey pipeline run that
    produced this checkpoint. `insights.run_id` and `insight_checkpoints_v2.run_id`
    both reference the SAME `agent_runs` row (they're written together by one
    pipeline run), so joining on `run_id` + `survey_id` precisely identifies the
    insights that fed this exact checkpoint — no blob I/O, no guessing by
    timestamp proximity.
    """
    if run_id is None:
        return []
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT id, citations_json FROM insights
                       WHERE run_id = %s AND survey_id = %s
                         AND citations_json IS NOT NULL AND citations_json != '[]'::jsonb
                       ORDER BY priority DESC NULLS LAST
                       LIMIT %s""",
                    (run_id, survey_id, limit),
                )
                rows = await cur.fetchall()
    except Exception as exc:
        logger.debug("tag_report_citation_lookup_failed", survey_id=survey_id, error=str(exc))
        return []

    out: list[dict] = []
    for insight_id, citations_json in rows:
        citations = citations_json if isinstance(citations_json, list) else (json.loads(citations_json) if citations_json else [])
        for c in citations[:limit]:
            if not isinstance(c, dict) or not c.get("response_id"):
                continue
            out.append({
                "survey_id": survey_id,
                "response_id": str(c["response_id"]),
                "source_insight_id": str(insight_id),
                "quote": c.get("quote", ""),
                "sentiment": c.get("sentiment", "neutral"),
                "relevance": c.get("relevance", 0.8),
            })
    return out[:limit]


async def node_merge_citation_manifest(state: TagReportState) -> dict:
    boundary_checkpoints = state.get("boundary_checkpoints") or {}
    narrated_tracks = state.get("narrated_tracks") or {}
    run_id = state["run_id"]
    events = list(state.get("stream_events") or [])

    contributing_survey_ids: set[str] = set()
    for track in narrated_tracks.values():
        contributing_survey_ids.update(track.get("eligible_survey_ids") or [])

    seen: set[tuple[str, str]] = set()
    manifest: list[dict] = []
    for sid in contributing_survey_ids:
        ckpts = boundary_checkpoints.get(sid) or {}
        for position in ("single", "start", "end"):
            ckpt = ckpts.get(position)
            if not ckpt:
                continue
            checkpoint_id = str(ckpt.get("id"))
            key = (sid, checkpoint_id)
            if key in seen:
                continue
            seen.add(key)
            real_citations = await _fetch_real_citations_for_checkpoint(
                sid, ckpt.get("run_id"), TAG_REPORT_CITATIONS_PER_SURVEY
            )
            if real_citations:
                manifest.extend(real_citations)
            else:
                # Fallback: no resolvable per-response citation for this checkpoint
                # (e.g. the source insight had no citations, or belongs to a survey
                # predating citation tracking). Keep a checkpoint-level placeholder
                # so the survey still has a manifest entry backing its contribution
                # to the report, even without drill-down content.
                manifest.append({
                    "survey_id": sid,
                    "checkpoint_id": checkpoint_id,
                    "bracket_position": position,
                    "citations_manifest_ref": ckpt.get("citations_manifest_ref"),
                    "created_at": ckpt.get("created_at"),
                })

    events.append(_event(run_id, "citations_merged",
                          citation_count=len(manifest), survey_count=len(contributing_survey_ids)))

    return {"citation_manifest": manifest, "stream_events": events}


# ── Terminal: publish ──────────────────────────────────────────────────────────

async def node_publish(state: TagReportState) -> dict:
    org_id = state["org_id"]
    run_id = state["run_id"]
    tag_id = state["tag_id"]
    narrated_tracks = state.get("narrated_tracks") or {}
    metric_tracks = state.get("metric_tracks") or {}
    included = state.get("included_surveys") or []
    excluded = state.get("excluded_surveys") or []
    boundary_checkpoints = state.get("boundary_checkpoints") or {}
    comparability_warnings = state.get("comparability_warnings") or []
    corroboration_signals = state.get("corroboration_signals") or []
    citation_manifest = state.get("citation_manifest") or []
    llm_call_count = state.get("llm_call_count", 0)
    events = list(state.get("stream_events") or [])
    errors = list(state.get("errors") or [])

    try:
        async with db._pool_conn().connection() as conn:
            for metric_key, narrated in narrated_tracks.items():
                track = metric_tracks.get(metric_key, {})
                eligible_ids = track.get("eligible_survey_ids") or []
                citations_for_track = [c for c in citation_manifest if c["survey_id"] in eligible_ids]
                async with conn.cursor() as cur:
                    await cur.execute(
                        """INSERT INTO group_insights
                             (id, org_id, run_id, tag_ids, survey_ids, layer, category,
                              headline, narrative, metric_json, citations_json,
                              trust_score, priority, metric_key, created_at)
                           VALUES (%s,%s,%s,%s::uuid[],%s::uuid[],%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                           ON CONFLICT (id) DO NOTHING""",
                        (
                            str(uuid.uuid4()), org_id, run_id, [tag_id], eligible_ids,
                            "descriptive", "tag_report_metric",
                            narrated.get("headline", ""), narrated.get("narrative", ""),
                            json.dumps({
                                "merged_delta": track.get("merged_delta"),
                                "direction": track.get("direction"),
                                "agreement_count": track.get("agreement_count"),
                                "confidence_tier": track.get("confidence_tier"),
                                # Fixed 2026-07-03 (QA finding): single_survey_id was
                                # computed in merge_metric_tracks but never persisted
                                # here — the "name that survey" disclosure R-T2/R-T2a
                                # require had no way to reach the frontend at all,
                                # regardless of the merge-logic fix above.
                                "single_survey_id": track.get("single_survey_id"),
                            }),
                            json.dumps(citations_for_track),
                            70 if track.get("confidence_tier") != "insufficient" else 40,
                            5, metric_key, datetime.now(timezone.utc),
                        ),
                    )

            for survey in included:
                sid = survey["survey_id"]
                boundary = boundary_checkpoints.get(sid) or {}
                if "single" in boundary:
                    positions = [("single", boundary.get("single"), "latest")]
                else:
                    positions = [
                        ("start", boundary.get("start"), "bracket_pair"),
                        ("end", boundary.get("end"), "bracket_pair"),
                    ]
                for position, ckpt, source_mode in positions:
                    if not ckpt:
                        continue
                    async with conn.cursor() as cur:
                        await cur.execute(
                            """INSERT INTO group_insight_run_sources
                                 (id, run_id, survey_id, checkpoint_id, org_id, bracket_position,
                                  source_mode, matched_checkpoint_window_start, matched_checkpoint_window_end,
                                  trend_eligible, response_count_at_generation, exclusion_reason)
                               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NULL)
                               ON CONFLICT (run_id, survey_id, bracket_position) DO NOTHING""",
                            (
                                str(uuid.uuid4()), run_id, sid, ckpt.get("id"), org_id, position,
                                source_mode, state.get("window_start"), state.get("window_end"),
                                survey.get("trend_eligible", False), survey.get("response_count", 0),
                            ),
                        )

            for survey in excluded:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """INSERT INTO group_insight_run_sources
                             (id, run_id, survey_id, checkpoint_id, org_id, bracket_position,
                              source_mode, trend_eligible, response_count_at_generation, exclusion_reason)
                           VALUES (%s,%s,%s,NULL,%s,'single','latest',FALSE,0,%s)
                           ON CONFLICT (run_id, survey_id, bracket_position) DO NOTHING""",
                        (str(uuid.uuid4()), run_id, survey["survey_id"], org_id,
                         survey.get("reason") or "no_checkpoint_in_range"),
                    )

            # duration_ms computed from the run_started event's timestamp (now always
            # seeded first by run_tag_report_generation) rather than left as a
            # permanent None placeholder — frontend's RunCompleteEvent type declares
            # this as a non-nullable number.
            duration_ms = None
            if events and events[0].get("event") == "run_started":
                try:
                    started_at = _parse_dt(events[0]["ts"])
                    if started_at is not None:
                        duration_ms = round((datetime.now(timezone.utc) - started_at).total_seconds() * 1000)
                except Exception:
                    duration_ms = None

            events.append(_event(run_id, "run_complete",
                                  metric_tracks_narrated=len(narrated_tracks),
                                  llm_call_count=llm_call_count,
                                  total_surveys_scanned=len(included) + len(excluded),
                                  total_surveys_included=len(included),
                                  duration_ms=duration_ms))

            async with conn.cursor() as cur:
                await cur.execute(
                    """UPDATE group_insight_runs
                       SET status = 'completed', completed_at = NOW(),
                           stream_events = %s::jsonb, result_json = %s::jsonb
                       WHERE id = %s AND org_id = %s""",
                    (
                        json.dumps(events),
                        json.dumps({
                            "metric_tracks_narrated": len(narrated_tracks),
                            "llm_call_count": llm_call_count,
                            "comparability_warnings": comparability_warnings,
                            "corroboration_signals": corroboration_signals,
                            "total_surveys_included": len(included),
                            "total_surveys_excluded": len(excluded),
                        }),
                        run_id, org_id,
                    ),
                )
            await conn.commit()

        logger.info("tag_report_published", run_id=run_id, metric_count=len(narrated_tracks))

    except Exception as exc:
        errors.append(f"publish: {exc}")
        logger.error("tag_report_publish_failed", run_id=run_id, error=str(exc), traceback=_tb.format_exc())
        events.append(_event(run_id, "run_failed", node="publish", error=str(exc)))
        try:
            async with db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """UPDATE group_insight_runs
                           SET status = 'failed', error_log = %s::jsonb
                           WHERE id = %s AND org_id = %s""",
                        (json.dumps(errors[-3:]), run_id, org_id),
                    )
                await conn.commit()
        except Exception:
            pass

    return {"stream_events": events, "errors": errors}


# ── Graph construction ────────────────────────────────────────────────────────

def build_tag_report_graph():
    """Build and compile the Tag Report LangGraph pipeline.

    Not a linear DAG: fetch_next_batch -> resolve_and_gate_batch loops via a
    conditional edge until target-N surveys are included, the ceiling is hit,
    or the tag's survey pool is exhausted (see _route_after_gate). Everything
    from compute_bracket_delta onward is a straight pipeline.
    """
    g = StateGraph(TagReportState)

    g.add_node("fetch_next_batch", node_fetch_next_batch)
    g.add_node("resolve_and_gate_batch", node_resolve_and_gate_batch)
    g.add_node("compute_bracket_delta", node_compute_bracket_delta)
    g.add_node("apply_trend_eligibility_gate", node_apply_trend_eligibility_gate)
    g.add_node("merge_metric_tracks", node_merge_metric_tracks)
    g.add_node("check_cross_track_corroboration", node_check_cross_track_corroboration)
    g.add_node("detect_comparability_warnings", node_detect_comparability_warnings)
    g.add_node("narrate_tag_report", node_narrate_tag_report)
    g.add_node("merge_citation_manifest", node_merge_citation_manifest)
    g.add_node("publish", node_publish)

    g.set_entry_point("fetch_next_batch")
    g.add_edge("fetch_next_batch", "resolve_and_gate_batch")
    g.add_conditional_edges(
        "resolve_and_gate_batch",
        _route_after_gate,
        {
            "continue":        "fetch_next_batch",
            "target_reached":  "compute_bracket_delta",
            "ceiling_hit":     "compute_bracket_delta",
            "pool_exhausted":  "compute_bracket_delta",
        },
    )
    g.add_edge("compute_bracket_delta", "apply_trend_eligibility_gate")
    g.add_edge("apply_trend_eligibility_gate", "merge_metric_tracks")
    g.add_edge("merge_metric_tracks", "check_cross_track_corroboration")
    g.add_edge("check_cross_track_corroboration", "detect_comparability_warnings")
    g.add_edge("detect_comparability_warnings", "narrate_tag_report")
    g.add_edge("narrate_tag_report", "merge_citation_manifest")
    g.add_edge("merge_citation_manifest", "publish")
    g.set_finish_point("publish")

    return g.compile()


_tag_report_graph = None


def _get_graph():
    global _tag_report_graph
    if _tag_report_graph is None:
        _tag_report_graph = build_tag_report_graph()
    return _tag_report_graph


async def run_tag_report_generation(
    *,
    run_id: str,
    org_id: str,
    tag_id: str,
    report_mode: str = "manual",
    window_start: str | None = None,
    window_end: str | None = None,
    target_n: int | None = None,
    ceiling_n: int | None = None,
    batch_size: int | None = None,
) -> None:
    """Entry point called by the FastAPI route (`POST /tag-reports/generate`).

    Runs the full Tag Report pipeline and writes results to DB. Errors are
    caught per-node; the run always ends in 'completed' or 'failed'.
    """
    target_n = target_n if target_n is not None else TAG_REPORT_DEFAULT_TARGET_N
    ceiling_n = ceiling_n if ceiling_n is not None else TAG_REPORT_CEILING_N
    batch_size = batch_size if batch_size is not None else TAG_REPORT_BATCH_SIZE

    logger.info("tag_report_generation_started", run_id=run_id, org_id=org_id, tag_id=tag_id,
                report_mode=report_mode, target_n=target_n)

    # Corrected 2026-07-02 (integration reconciliation): TRACKER.md §2's streaming
    # event contract lists `run_started` as the FIRST event ("Initialize timeline
    # canvas") carrying target_n/ceiling_n, but no node ever emitted it — the
    # frontend's progress reducer (tagReportProgress.ts) reads target_n/ceiling_n
    # exclusively off this event, so its absence left those fields permanently
    # null. Seeded into stream_events here, before the graph runs, rather than as
    # a node, since it describes the run's initial parameters, not a pipeline step.
    initial_events = [_event(run_id, "run_started", tag_id=tag_id, report_mode=report_mode,
                              target_n=target_n, ceiling_n=ceiling_n)]

    initial_state: TagReportState = {
        "org_id": org_id, "run_id": run_id, "tag_id": tag_id, "report_mode": report_mode,
        "window_start": window_start, "window_end": window_end,
        "target_n": target_n, "ceiling_n": ceiling_n, "batch_size": batch_size,
        "cursor": 0, "loop_iterations": 0,
        "candidate_pool": None, "current_batch": [],
        "included_surveys": [], "excluded_surveys": [],
        "boundary_checkpoints": {}, "bracket_deltas": {}, "bracket_topic_lifecycle": {},
        "metric_tracks": {}, "merge_votes": [], "corroboration_signals": [],
        "comparability_warnings": [], "narrated_tracks": {}, "llm_call_count": 0,
        "citation_manifest": [], "stream_events": initial_events, "errors": [],
    }

    try:
        graph = _get_graph()
        config = {"configurable": {"thread_id": f"tag_report:{run_id}"}, "recursion_limit": 200}
        await graph.ainvoke(initial_state, config)
        logger.info("tag_report_generation_complete", run_id=run_id)
    except Exception as exc:
        logger.error("tag_report_generation_fatal", run_id=run_id, error=str(exc), traceback=_tb.format_exc())
        try:
            async with db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """UPDATE group_insight_runs
                           SET status = 'failed', error_log = %s::jsonb
                           WHERE id = %s AND org_id = %s""",
                        (json.dumps([f"fatal: {str(exc)}"]), run_id, org_id),
                    )
                await conn.commit()
        except Exception:
            pass
