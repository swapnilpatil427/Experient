#!/usr/bin/env python3
"""Insight generation scheduler.

Runs as a separate process (not part of the FastAPI server).
Periodically enqueues insight generation for surveys that:
  - Have responses (response_count > 0)
  - Haven't been regenerated recently (based on tier interval)
  - Are in 'active' or 'paused' status (closed surveys are excluded)

Usage:
  python -m agents.scheduler

Or via the Makefile:
  make scheduler

Interval env vars:
  INSIGHT_INTERVAL_FREE_MIN   default: 120  (minutes between free-tier runs)
  INSIGHT_INTERVAL_PAID_MIN   default: 15   (minutes between paid-tier runs)
  SCHEDULER_POLL_SEC          default: env-aware (dev: 300s, prod: 3600s)
  ENABLE_RESPONSE_TAGGING_BACKLOG_SWEEP  default: true (15-min backlog sweep for
                                          untagged responses — see
                                          run_response_tagging_backlog_sweep)
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime

import dotenv
import httpx

dotenv.load_dotenv()

from crystalos.lib.db import init_pool, close_pool, _pool_conn
from crystalos.lib.logger import logger

AGENTS_URL          = os.getenv("AGENTS_URL",          "http://localhost:8001")
AGENTS_INTERNAL_KEY = os.getenv("AGENTS_INTERNAL_KEY", "dev-internal-key-change-in-prod")

_ENV = os.getenv("AGENTS_ENV", "dev").lower()

# How often the scheduler wakes up and checks for surveys that need processing.
# Prod: 1 hour — avoids unnecessary DB scans and LLM costs at enterprise scale.
# Dev/staging: 5 minutes — tighter feedback loop during development.
# Override via SCHEDULER_POLL_SEC for any env.
_POLL_SEC_DEFAULTS = {
    "prod":     3600,   # 1 hour
    "staging":  300,    # 5 minutes
    "dev-paid": 300,    # 5 minutes
    "dev":      300,    # 5 minutes
}
_POLL_SEC_DEFAULT = _POLL_SEC_DEFAULTS.get(_ENV, 300)

INTERVAL_FREE_MIN = int(os.getenv("INSIGHT_INTERVAL_FREE_MIN", "120"))  # 2 hours
INTERVAL_PAID_MIN = int(os.getenv("INSIGHT_INTERVAL_PAID_MIN", "15"))   # 15 minutes
POLL_SEC          = int(os.getenv("SCHEDULER_POLL_SEC", str(_POLL_SEC_DEFAULT)))


async def _trigger_generation(survey_id: str, org_id: str) -> bool:
    """Call the agents service to start insight generation. Returns True on success."""
    thread_id = f"insight:scheduled:{org_id}:{survey_id}:{int(time.time())}"

    # Create an agent_run row directly in the DB
    run_id: str | None = None
    async with _pool_conn().connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """INSERT INTO agent_runs
                       (org_id, user_id, thread_id, run_type, status, intent, survey_id)
                   VALUES (%s, 'scheduler', %s, 'insight_generation', 'running', 'insight:schedule', %s)
                   RETURNING id""",
                (org_id, thread_id, survey_id),
            )
            row = await cur.fetchone()
            if row is None:
                logger.error("scheduler_insert_failed", survey_id=survey_id)
                return False
            run_id = str(row[0])

    # Fire the agents service endpoint
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(
                f"{AGENTS_URL}/insights/generate",
                json={
                    "survey_id": survey_id,
                    "org_id":    org_id,
                    "run_id":    run_id,
                    "trigger":   "schedule",
                },
                headers={"X-Internal-Key": AGENTS_INTERNAL_KEY},
            )
            res.raise_for_status()
        logger.info("scheduler_triggered", survey_id=survey_id, org_id=org_id, run_id=run_id)
        return True
    except Exception as exc:
        logger.warning("scheduler_trigger_failed", survey_id=survey_id, error=str(exc))
        async with _pool_conn().connection() as conn:
            await conn.execute(
                "UPDATE agent_runs SET status='failed', completed_at=NOW() WHERE id=%s",
                (run_id,),
            )
        return False


async def _recover_stale_runs() -> int:
    """Mark runs stuck in 'running' for >10 minutes as 'cancelled'.

    Returns the count of runs recovered.
    """
    try:
        async with _pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """UPDATE agent_runs
                       SET status='cancelled', completed_at=NOW()
                       WHERE run_type='insight_generation'
                         AND status='running'
                         AND created_at < NOW() - INTERVAL '10 minutes'
                       RETURNING id""",
                )
                rows = await cur.fetchall()
                count = len(rows)
            await conn.commit()
        if count:
            logger.info("scheduler_stale_recovery", recovered=count)
        return count
    except Exception as exc:
        logger.warning("scheduler_stale_recovery_failed", error=str(exc))
        return 0


async def sweep_zombie_runs() -> None:
    """Mark stale running runs as failed and enqueue retries for eligible ones."""
    from crystalos.lib.constants import MAX_RUN_HEARTBEAT_STALE_MINUTES, MAX_RUN_DURATION_MINUTES
    try:
        async with _pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT id, survey_id, org_id, retry_count, run_type
                       FROM agent_runs
                       WHERE status = 'running'
                         AND (
                           last_heartbeat_at < NOW() - INTERVAL '%s minutes'
                           OR created_at < NOW() - INTERVAL '%s minutes'
                         )""",
                    (MAX_RUN_HEARTBEAT_STALE_MINUTES, MAX_RUN_DURATION_MINUTES),
                )
                zombies = await cur.fetchall()

        for zombie_id, survey_id, org_id, retry_count, run_type in zombies:
            async with _pool_conn().connection() as conn:
                await conn.execute(
                    """UPDATE agent_runs
                       SET status = 'failed',
                           failure_reason = 'zombie_timeout',
                           failed_at = NOW()
                       WHERE id = %s AND status = 'running'""",
                    (zombie_id,),
                )
            logger.warning(
                "zombie_run_killed",
                run_id=str(zombie_id),
                survey_id=str(survey_id) if survey_id else None,
                run_type=run_type,
            )
            # Retry is insight-generation-specific (_trigger_generation kicks off a
            # fresh insight run). Fixed 2026-07-13: this used to fire unconditionally
            # for ANY zombied run_type — a zombied topic_backfill run would have been
            # incorrectly "retried" as a brand-new insight-generation run. A backfill
            # job doesn't need this retry at all: the scheduler's own backlog sweep
            # (run_response_tagging_backlog_sweep) keeps draining the same untagged
            # rows regardless, and the user can just click the button again.
            if run_type == "insight_generation" and (retry_count or 0) < 2 and survey_id and org_id:
                await _trigger_generation(str(survey_id), str(org_id))
    except Exception as exc:
        logger.error("zombie_sweep_failed", error=str(exc))


async def _auto_close_by_date() -> int:
    """Close active/paused surveys that have passed their auto_close_at datetime."""
    try:
        async with _pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """UPDATE surveys
                       SET status='closed', closed_at=NOW()
                       WHERE status IN ('active','paused')
                         AND auto_close_at IS NOT NULL
                         AND auto_close_at < NOW()
                       RETURNING id"""
                )
                rows = await cur.fetchall()
                count = len(rows)
            await conn.commit()
        if count:
            logger.info("scheduler_auto_closed_by_date", count=count)
        return count
    except Exception as exc:
        logger.warning("scheduler_auto_close_date_failed", error=str(exc))
        return 0


async def _auto_close_by_response_count() -> int:
    """Close active surveys that have hit their max_responses limit."""
    try:
        async with _pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """UPDATE surveys
                       SET status='closed', closed_at=NOW()
                       WHERE status = 'active'
                         AND max_responses IS NOT NULL
                         AND (
                           SELECT COUNT(*) FROM responses r WHERE r.survey_id = surveys.id
                         ) >= max_responses
                       RETURNING id"""
                )
                rows = await cur.fetchall()
                count = len(rows)
            await conn.commit()
        if count:
            logger.info("scheduler_auto_closed_by_count", count=count)
        return count
    except Exception as exc:
        logger.warning("scheduler_auto_close_count_failed", error=str(exc))
        return 0


async def _get_surveys_due(interval_minutes: int) -> list[dict]:
    """Return surveys that are due for insight regeneration.

    A survey is due when:
    - It has responses
    - No completed/running run exists within the interval window
    - Stale runs (>10 min) have already been cleared by _recover_stale_runs
    """
    async with _pool_conn().connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT s.id, s.org_id
                FROM surveys s
                WHERE s.status IN ('active', 'paused')
                  AND s.deleted_at IS NULL
                  AND (SELECT COUNT(*) FROM responses r WHERE r.survey_id = s.id) > 0
                  AND NOT EXISTS (
                      SELECT 1 FROM agent_runs ar
                      WHERE ar.survey_id = s.id
                        AND ar.run_type = 'insight_generation'
                        AND ar.status IN ('running', 'completed')
                        AND ar.created_at > NOW() - (%s * INTERVAL '1 minute')
                  )
                ORDER BY (SELECT COUNT(*) FROM responses r WHERE r.survey_id = s.id) DESC
                LIMIT 20
                """,
                (interval_minutes,),
            )
            rows = await cur.fetchall()
            cols = [desc[0] for desc in cur.description]
            return [dict(zip(cols, r)) for r in rows]


async def _get_last_run_response_count(survey_id: str) -> int | None:
    """Return the response count stored in the last completed insight run, or None."""
    try:
        async with _pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT stream_events FROM agent_runs
                       WHERE survey_id = %s
                         AND run_type = 'insight_generation'
                         AND status = 'completed'
                       ORDER BY created_at DESC
                       LIMIT 1""",
                    (survey_id,),
                )
                row = await cur.fetchone()
                if row is None:
                    return None
                events = row[0] if isinstance(row[0], list) else []
                for evt in reversed(events):  # newest event first
                    if isinstance(evt, dict) and evt.get("event") == "response_count":
                        return int(evt.get("count", 0))
    except Exception:
        pass
    return None


async def _get_current_response_count(survey_id: str) -> int:
    try:
        async with _pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT COUNT(*) FROM responses WHERE survey_id = %s",
                    (survey_id,),
                )
                row = await cur.fetchone()
                return int(row[0]) if row else 0
    except Exception:
        return 0


_ZOMBIE_SWEEP_INTERVAL_SEC = 300  # 5 minutes

_org_aggregation_last_run: float = 0.0
_ORG_AGGREGATION_INTERVAL_SEC = 3600  # 1 hour

_sla_check_last_run: float = 0.0
_SLA_CHECK_INTERVAL_SEC = 900  # 15 minutes

_skill_quality_last_run: float = 0.0
_SKILL_QUALITY_INTERVAL_SEC = 86400  # 24 hours — nightly

_feedback_rollup_last_run: float = 0.0
_FEEDBACK_ROLLUP_INTERVAL_SEC = 3600  # hourly

_quality_sla_last_run: float = 0.0
_QUALITY_SLA_INTERVAL_SEC = 86400  # nightly

_gap_cluster_last_run: float = 0.0
_GAP_CLUSTER_INTERVAL_SEC = 604800  # weekly

_CX_SLA_BREACH_INTERVAL_SEC = 300  # 5 minutes


async def run_org_aggregation() -> None:
    """Aggregate NPS/CSAT across all active surveys per org into org_metric_snapshots.

    Runs hourly. Provides data for Crystal's get_org_portfolio tool.
    """
    try:
        async with _pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                # Get all active orgs with responses
                await cur.execute(
                    """SELECT DISTINCT org_id FROM surveys s
                       WHERE status = 'active' AND deleted_at IS NULL
                         AND EXISTS (
                             SELECT 1 FROM responses r WHERE r.survey_id = s.id
                         )"""
                )
                org_rows = await cur.fetchall()

        for (org_id,) in org_rows:
            try:
                async with _pool_conn().connection() as conn:
                    async with conn.cursor() as cur:
                        await cur.execute(
                            """SELECT AVG(sms.nps), AVG(sms.csat), SUM(sms.response_count),
                                      COUNT(*) as survey_count
                               FROM survey_metric_snapshots sms
                               INNER JOIN surveys s ON s.id = sms.survey_id
                               WHERE sms.org_id = %s AND s.status = 'active'
                                 AND s.deleted_at IS NULL
                                 AND sms.captured_at = (
                                     SELECT MAX(captured_at) FROM survey_metric_snapshots
                                     WHERE survey_id = sms.survey_id
                                 )""",
                            (org_id,),
                        )
                        row = await cur.fetchone()
                        if not row or row[3] == 0:
                            continue

                        avg_nps, avg_csat, total_responses, survey_count = row

                    async with conn.cursor() as cur:
                        await cur.execute(
                            """INSERT INTO org_metric_snapshots
                               (org_id, captured_at, avg_nps, avg_csat, total_responses, active_survey_count)
                               VALUES (%s, NOW(), %s, %s, %s, %s)""",
                            (org_id, avg_nps, avg_csat, total_responses, survey_count),
                        )
                    await conn.commit()
                    logger.info("org_aggregation_written", org_id=org_id, survey_count=survey_count)
            except Exception as exc:
                logger.warning("org_aggregation_org_failed", org_id=org_id, error=str(exc))

    except Exception as exc:
        logger.error("org_aggregation_failed", error=str(exc))


async def _aggregate_skill_quality() -> None:
    """Nightly: update skill_quality_metrics from turn events (last 30 days).

    Uses an UPSERT so subsequent runs are idempotent.
    Skill names are extracted from the JSON tools_called JSONB array.
    """
    try:
        async with _pool_conn().connection() as conn:
            await conn.execute("""
                INSERT INTO skill_quality_metrics
                    (skill_name, org_id, brand_id, total_runs, pass_count,
                     avg_eval_score, positive_signals, negative_signals,
                     p50_latency_ms, last_updated)
                SELECT
                    tc.tool_name as skill_name,
                    e.org_id,
                    COALESCE(e.brand_id, '') as brand_id,
                    COUNT(*) as total_runs,
                    COUNT(*) FILTER (WHERE e.eval_score >= 0.75) as pass_count,
                    AVG(e.eval_score) as avg_eval_score,
                    COUNT(*) FILTER (WHERE e.quality_signal = 'positive') as positive_signals,
                    COUNT(*) FILTER (WHERE e.quality_signal = 'negative') as negative_signals,
                    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY e.latency_ms)::int as p50_latency_ms,
                    NOW()
                FROM crystal_turn_events e,
                     jsonb_array_elements(e.tools_called) AS tc_elem,
                     LATERAL (SELECT tc_elem->>'tool' as tool_name) tc
                WHERE e.created_at > NOW() - INTERVAL '30 days'
                  AND tc.tool_name IS NOT NULL
                GROUP BY tc.tool_name, e.org_id, e.brand_id
                ON CONFLICT (skill_name, org_id, brand_id)
                DO UPDATE SET
                    total_runs = EXCLUDED.total_runs,
                    pass_count = EXCLUDED.pass_count,
                    avg_eval_score = EXCLUDED.avg_eval_score,
                    positive_signals = EXCLUDED.positive_signals,
                    negative_signals = EXCLUDED.negative_signals,
                    p50_latency_ms = EXCLUDED.p50_latency_ms,
                    last_updated = NOW()
            """)
        logger.info("skill_quality_aggregation_complete")
    except Exception as exc:
        logger.error("skill_quality_aggregation_failed", error=str(exc))


async def _flag_low_quality_skills() -> None:
    """Flag skills with avg_eval_score < 0.6 or neg_rate > 0.3 with at least 20 runs."""
    try:
        async with _pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute("""
                    SELECT skill_name, avg_eval_score,
                           negative_signals::float / NULLIF(total_runs, 0) as neg_rate
                    FROM skill_quality_metrics
                    WHERE total_runs >= 20
                      AND (avg_eval_score < 0.6
                           OR negative_signals::float / NULLIF(total_runs, 0) > 0.3)
                """)
                low_quality = await cur.fetchall()

        for row in low_quality:
            skill_name, avg_eval_score, neg_rate = row
            logger.warning(
                "skill_quality_alert",
                skill=skill_name,
                eval_score=float(avg_eval_score) if avg_eval_score is not None else None,
                neg_rate=float(neg_rate) if neg_rate is not None else None,
            )
    except Exception as exc:
        logger.error("skill_quality_flag_failed", error=str(exc))


async def _rollup_feedback_hour() -> None:
    """Aggregate crystal_turn_events into feedback_hourly_rollups.

    Computes per-org/brand/skill aggregates for the previous full hour window.
    Runs hourly. Silently no-ops if the table is unavailable.
    """
    try:
        async with _pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """INSERT INTO feedback_hourly_rollups
                       (hour, org_id, brand_id, skill_name,
                        total_turns, positive_count, negative_count, avg_eval_score)
                       SELECT
                           date_trunc('hour', created_at) as hour,
                           org_id,
                           COALESCE(brand_id, '') as brand_id,
                           COALESCE(specialist_used, '') as skill_name,
                           COUNT(*) as total_turns,
                           COUNT(*) FILTER (WHERE quality_signal = 'positive') as positive_count,
                           COUNT(*) FILTER (WHERE quality_signal = 'negative') as negative_count,
                           AVG(eval_score)::decimal(4,3) as avg_eval_score
                       FROM crystal_turn_events
                       WHERE created_at >= date_trunc('hour', NOW() - INTERVAL '1 hour')
                         AND created_at <  date_trunc('hour', NOW())
                       GROUP BY 1, 2, 3, 4
                       ON CONFLICT (hour, org_id, brand_id, skill_name)
                       DO UPDATE SET
                           total_turns    = EXCLUDED.total_turns,
                           positive_count = EXCLUDED.positive_count,
                           negative_count = EXCLUDED.negative_count,
                           avg_eval_score = EXCLUDED.avg_eval_score"""
                )
            await conn.commit()
        logger.info("feedback_hourly_rollup_done")
    except Exception as exc:
        logger.warning("feedback_hourly_rollup_failed", error=str(exc))


async def _check_quality_sla_compliance() -> None:
    """Check each brand's quality SLA and record any breaches.

    Runs nightly. Compares rolling 7-day metrics against quality_sla_configs.
    """
    try:
        async with _pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT brand_id, positive_rate_min, avg_eval_score_min, measurement_window
                       FROM quality_sla_configs"""
                )
                configs = await cur.fetchall()

        for (brand_id, positive_rate_min, avg_eval_score_min, measurement_window) in configs:
            try:
                async with _pool_conn().connection() as conn:
                    async with conn.cursor() as cur:
                        await cur.execute(
                            """SELECT
                                   SUM(total_turns) as total,
                                   SUM(positive_count) as positives,
                                   AVG(avg_eval_score) as avg_score
                               FROM feedback_hourly_rollups
                               WHERE brand_id = %s
                                 AND hour > NOW() - %s::interval""",
                            (brand_id, str(measurement_window)),
                        )
                        row = await cur.fetchone()
                        if not row or not row[0]:
                            continue
                        total, positives, avg_score = row
                        if not total:
                            continue
                        positive_rate = float(positives or 0) / float(total)

                    if float(positive_rate_min or 0) > 0 and positive_rate < float(positive_rate_min):
                        async with conn.cursor() as cur:
                            await cur.execute(
                                """INSERT INTO quality_sla_breaches
                                   (brand_id, breach_type, measured_value, threshold_value,
                                    window_start, window_end)
                                   VALUES (%s, 'positive_rate', %s, %s, NOW() - %s::interval, NOW())""",
                                (brand_id, round(positive_rate, 4), float(positive_rate_min), str(measurement_window)),
                            )

                    if avg_score is not None and float(avg_eval_score_min or 0) > 0 and float(avg_score) < float(avg_eval_score_min):
                        async with conn.cursor() as cur:
                            await cur.execute(
                                """INSERT INTO quality_sla_breaches
                                   (brand_id, breach_type, measured_value, threshold_value,
                                    window_start, window_end)
                                   VALUES (%s, 'eval_score', %s, %s, NOW() - %s::interval, NOW())""",
                                (brand_id, round(float(avg_score), 4), float(avg_eval_score_min), str(measurement_window)),
                            )

                    await conn.commit()
                    logger.debug("quality_sla_checked", brand_id=brand_id, positive_rate=round(positive_rate, 4))

            except Exception as exc:
                logger.warning("quality_sla_brand_check_failed", brand_id=brand_id, error=str(exc))

    except Exception as exc:
        logger.warning("quality_sla_compliance_failed", error=str(exc))


async def _cluster_capability_gaps() -> None:
    """Cluster low-scoring Crystal queries to identify capability gaps.

    Runs weekly. Groups queries into clusters and stores in capability_gap_clusters
    for product review.
    """
    try:
        async with _pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT message, eval_score
                       FROM crystal_turn_events
                       WHERE eval_score < 0.5
                         AND message IS NOT NULL
                         AND created_at > NOW() - INTERVAL '7 days'
                       ORDER BY created_at DESC
                       LIMIT 500"""
                )
                rows = await cur.fetchall()

        if not rows:
            logger.debug("gap_cluster_no_data")
            return

        from collections import defaultdict
        clusters: dict[str, list[str]] = defaultdict(list)
        stop_words = {"what", "how", "when", "where", "why", "show", "tell", "give", "find", "is", "are", "can", "does"}

        for (message, _score) in rows:
            if not message:
                continue
            tokens = [t.lower().strip("?.,!") for t in str(message).split() if len(t) > 3]
            key_tokens = [t for t in tokens if t not in stop_words]
            cluster_key = key_tokens[0] if key_tokens else "other"
            clusters[cluster_key].append(str(message)[:200])

        week = time.strftime("%Y-%m-%d")
        async with _pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                for cluster_label, queries in sorted(clusters.items(), key=lambda x: -len(x[1]))[:20]:
                    sample_queries = queries[:5]
                    await cur.execute(
                        """INSERT INTO capability_gap_clusters
                           (cluster_label, query_count, sample_queries, week)
                           VALUES (%s, %s, %s, %s)
                           ON CONFLICT DO NOTHING""",
                        (cluster_label, len(queries), sample_queries, week),
                    )
            await conn.commit()

        logger.info("gap_clusters_written", cluster_count=len(clusters))
    except Exception as exc:
        logger.warning("gap_cluster_failed", error=str(exc))


async def _check_sla_breaches() -> None:
    """Every 15 minutes: enforce bug SLAs — mark overdue unacknowledged bugs as breached."""
    from crystalos.lib.bug_tracker import check_sla_breaches
    try:
        async with _pool_conn().connection() as conn:
            await check_sla_breaches(conn)
    except Exception as exc:
        logger.warning("sla_check_failed", error=str(exc))


async def _cx_sla_breach_sweep() -> None:
    """Every 5 minutes: detect SLA breaches on open CX cases and escalate.

    For each case where resolve_due_at < NOW() and not yet breached and not resolved/closed:
    1. Increment escalation_tier, set sla_breached=true, append to audit_log
    2. Resolve escalation owner from ownership_routes (escalation_user_id on matched route)
    3. Reassign case owner to escalation_user_id if found
    4. Send Slack webhook if external_refs.slack_webhook is set
    5. Insert into crystal_event_queue: {type: case_sla_breach, payload: {case_id, org_id, escalation_tier}}
    """
    try:
        async with _pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT id, org_id, title, severity, escalation_tier,
                              owner_user_id, external_refs
                       FROM cx_cases
                       WHERE resolve_due_at < NOW()
                         AND sla_breached = false
                         AND status NOT IN ('resolved', 'closed')"""
                )
                breached_cases = await cur.fetchall()
                cols = [d[0] for d in cur.description]

        for row in breached_cases:
            case = dict(zip(cols, row))
            case_id = str(case["id"])
            org_id = str(case["org_id"])
            new_tier = int(case.get("escalation_tier") or 0) + 1
            external_refs = case.get("external_refs") or {}
            if isinstance(external_refs, str):
                try:
                    import json as _json
                    external_refs = _json.loads(external_refs)
                except Exception:
                    external_refs = {}

            # Resolve escalation owner from ownership_routes
            escalation_owner_id = None
            try:
                async with _pool_conn().connection() as conn:
                    async with conn.cursor() as cur:
                        await cur.execute(
                            """SELECT escalation_user_id
                               FROM ownership_routes
                               WHERE org_id = %s AND escalation_user_id IS NOT NULL
                               ORDER BY priority ASC LIMIT 1""",
                            (org_id,),
                        )
                        route_row = await cur.fetchone()
                        if route_row and route_row[0]:
                            escalation_owner_id = str(route_row[0])
            except Exception as exc:
                logger.warning("cx_sla_escalation_route_failed", case_id=case_id, error=str(exc))

            # Update case: mark breached, increment escalation_tier, reassign if escalation owner found
            try:
                async with _pool_conn().connection() as conn:
                    async with conn.cursor() as cur:
                        update_fields = [
                            "sla_breached = true",
                            "escalation_tier = %s",
                            "audit_log = COALESCE(audit_log, '[]'::jsonb) || %s::jsonb",
                        ]
                        audit_entry = json.dumps([{
                            "event": "sla_breach",
                            "escalation_tier": new_tier,
                            "ts": datetime.utcnow().isoformat()
                        }])
                        update_args: list = [
                            new_tier,
                            audit_entry,
                        ]
                        if escalation_owner_id:
                            update_fields.append("owner_user_id = %s")
                            update_args.append(escalation_owner_id)
                        update_args.append(case_id)
                        await cur.execute(
                            f"UPDATE cx_cases SET {', '.join(update_fields)} WHERE id = %s",
                            update_args,
                        )

                        # Insert into crystal_event_queue
                        await cur.execute(
                            """INSERT INTO crystal_event_queue (type, payload, org_id, created_at)
                               VALUES ('case_sla_breach', %s::jsonb, %s, NOW())""",
                            (
                                json.dumps({"case_id": case_id, "org_id": org_id, "escalation_tier": new_tier}),
                                org_id,
                            ),
                        )
                    await conn.commit()

                logger.warning(
                    "cx_case_sla_breached",
                    case_id=case_id,
                    org_id=org_id,
                    escalation_tier=new_tier,
                    escalation_owner_id=escalation_owner_id,
                )
            except Exception as exc:
                logger.error("cx_sla_breach_update_failed", case_id=case_id, error=str(exc))
                continue

            # Send Slack webhook if configured
            slack_webhook = external_refs.get("slack_webhook")
            if slack_webhook:
                try:
                    import httpx as _httpx
                    message = (
                        f":rotating_light: *SLA Breach* — Case #{case_id[:8]}: {case.get('title', 'Untitled')}\n"
                        f"Severity: {case.get('severity', 'unknown')} | Escalation tier: {new_tier}"
                    )
                    async with _httpx.AsyncClient(timeout=10.0) as client:
                        await client.post(slack_webhook, json={"text": message})
                except Exception as exc:
                    logger.warning("cx_sla_slack_notify_failed", case_id=case_id, error=str(exc))

    except Exception as exc:
        logger.error("cx_sla_breach_sweep_failed", error=str(exc))


# ── Phase 7 — automated checkpoint retention / compaction (03 §12) ─────────────
# Gated behind ENABLE_RETENTION_JOB (default false) so it is a no-op in dev unless
# explicitly enabled. Idempotent + safe: only ever touches automated-lane checkpoints
# with meaningful_delta=false older than the per-survey retention window; never
# meaningful_delta=true rows, never manual reports, never the insights table.
#
# Phase 7 readiness: default to enabled when insight_checkpoints_v2 is active
# (the retention job only operates on v2 rows — `insight_checkpoints_v2` lane='automated').
# Explicit ENABLE_RETENTION_JOB env var always wins; the v2 flag sets the smart default.
from crystalos.lib.constants import INSIGHT_CHECKPOINTS_V2_ENABLED as _V2_ENABLED
ENABLE_RETENTION_JOB: bool = os.getenv(
    "ENABLE_RETENTION_JOB",
    "true" if _V2_ENABLED else "false",
).lower() == "true"

_retention_last_run: float = 0.0
_RETENTION_INTERVAL_SEC = 86400  # nightly

# Low-delta blobs are dropped after this many days (UI keeps the rollup marker row).
RETENTION_BLOB_DROP_DAYS: int = int(os.getenv("RETENTION_BLOB_DROP_DAYS", "30"))


async def run_retention_job() -> dict:
    """Collapse low-delta automated checkpoints into rollup markers (03 §12).

    Policy (automated lane only):
      - Keep every checkpoint with meaningful_delta=true for the full retention period.
      - For meaningful_delta=false checkpoints older than the survey's
        automated_checkpoint_retention_days: mark them collapsed (rollup marker) so
        the UI groups them, and drop their report_blob_ref after RETENTION_BLOB_DROP_DAYS.

    Idempotent — re-running only touches rows not already collapsed/blob-cleared.
    Returns a counts dict for observability/tests. Never raises.

    The collapse is recorded in lineage_json.rollup_collapsed=true (additive — no
    schema change required) so a later run skips already-collapsed rows. Manual-lane
    rows and meaningful_delta=true rows are never selected.
    """
    if not ENABLE_RETENTION_JOB:
        logger.debug("retention_job_disabled")
        return {"enabled": False, "collapsed": 0, "blobs_dropped": 0}

    collapsed = 0
    blobs_dropped = 0
    try:
        # ── 1. Collapse low-delta automated checkpoints past the retention window ──
        # Join each checkpoint to its survey's retention setting (default 365), with a
        # 3-level COALESCE to org defaults / platform constant. collapse_similar_checkpoints
        # must be on (default true) for the survey.
        async with _pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    WITH eff AS (
                      SELECT v.id,
                             COALESCE(s.automated_checkpoint_retention_days,
                                      o.automated_checkpoint_retention_days, 365) AS retention_days,
                             COALESCE(s.collapse_similar_checkpoints,
                                      o.collapse_similar_checkpoints, TRUE) AS collapse_on,
                             v.created_at
                      FROM insight_checkpoints_v2 v
                      LEFT JOIN survey_insight_settings s ON s.survey_id = v.survey_id
                      LEFT JOIN org_insight_defaults o ON o.org_id = v.org_id
                      WHERE v.lane = 'automated'
                        AND v.meaningful_delta = FALSE
                        AND COALESCE((v.lineage_json->>'rollup_collapsed')::boolean, FALSE) = FALSE
                    )
                    UPDATE insight_checkpoints_v2 v
                    SET lineage_json = COALESCE(v.lineage_json, '{}'::jsonb)
                                       || jsonb_build_object('rollup_collapsed', true,
                                                             'rollup_collapsed_at', NOW()::text)
                    FROM eff
                    WHERE v.id = eff.id
                      AND eff.collapse_on = TRUE
                      AND eff.created_at < NOW() - (eff.retention_days * INTERVAL '1 day')
                    RETURNING v.id
                    """,
                )
                rows = await cur.fetchall()
                collapsed = len(rows)
            await conn.commit()

        # ── 2. Drop blobs of collapsed low-delta checkpoints after the grace window ──
        async with _pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """UPDATE insight_checkpoints_v2
                       SET report_blob_ref = NULL
                       WHERE lane = 'automated'
                         AND meaningful_delta = FALSE
                         AND report_blob_ref IS NOT NULL
                         AND COALESCE((lineage_json->>'rollup_collapsed')::boolean, FALSE) = TRUE
                         AND created_at < NOW() - (%s * INTERVAL '1 day')
                       RETURNING id""",
                    (RETENTION_BLOB_DROP_DAYS,),
                )
                rows = await cur.fetchall()
                blobs_dropped = len(rows)
            await conn.commit()

        if collapsed or blobs_dropped:
            logger.info("retention_job_done", collapsed=collapsed, blobs_dropped=blobs_dropped)
        else:
            logger.debug("retention_job_noop")
        return {"enabled": True, "collapsed": collapsed, "blobs_dropped": blobs_dropped}
    except Exception as exc:
        logger.warning("retention_job_failed", error=str(exc))
        return {"enabled": True, "collapsed": collapsed, "blobs_dropped": blobs_dropped,
                "error": str(exc)}


# ── Response tagging backlog sweep (added 2026-07-04) ──────────────────────────
# consumers/response_stream.py already tags each survey's responses as new ones
# arrive (see lib/response_tagging.py, gated by response_tagging_batch_size). This
# job is the safety net for the cases that path can't reach on its own: surveys
# that aren't currently receiving live traffic (imported/bulk-loaded responses,
# or a survey that's gone quiet), and any response whose scoring attempt
# previously failed (it simply never got ai_enriched_at set, so it's still
# selected here — no separate retry-tracking needed, same as the stream path).
ENABLE_RESPONSE_TAGGING_BACKLOG_SWEEP: bool = os.getenv(
    "ENABLE_RESPONSE_TAGGING_BACKLOG_SWEEP", "true",
).lower() == "true"

_response_tagging_backlog_last_run: float = 0.0
_RESPONSE_TAGGING_BACKLOG_INTERVAL_SEC = 900  # 15 minutes

# Cap how many distinct surveys get swept per tick — each one calls
# tag_untagged_responses, which itself caps at RESPONSE_TAGGING_SWEEP_CAP
# responses. Keeps one tick's total work bounded regardless of backlog size.
RESPONSE_TAGGING_BACKLOG_MAX_SURVEYS_PER_TICK: int = int(
    os.getenv("RESPONSE_TAGGING_BACKLOG_MAX_SURVEYS_PER_TICK", "20")
)


async def run_response_tagging_backlog_sweep() -> dict:
    """Find surveys with untagged responses and run a tagging sweep for each.

    Returns {"enabled": bool, "surveys_swept": int, "error"?: str}. Never raises.
    """
    if not ENABLE_RESPONSE_TAGGING_BACKLOG_SWEEP:
        logger.debug("response_tagging_backlog_sweep_disabled")
        return {"enabled": False, "surveys_swept": 0}

    from crystalos.lib.response_tagging import tag_untagged_responses

    surveys_swept = 0
    try:
        async with _pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT DISTINCT survey_id, org_id
                       FROM responses
                       WHERE ai_enriched_at IS NULL
                       LIMIT %s""",
                    (RESPONSE_TAGGING_BACKLOG_MAX_SURVEYS_PER_TICK,),
                )
                rows = await cur.fetchall()

        for survey_id, org_id in rows:
            try:
                await tag_untagged_responses(str(survey_id), org_id)
                surveys_swept += 1
            except Exception as exc:
                logger.warning("response_tagging_backlog_sweep_survey_failed",
                                survey_id=survey_id, error=str(exc))
            await asyncio.sleep(1)  # stagger — same rationale as the main survey loop below

        if surveys_swept:
            logger.info("response_tagging_backlog_sweep_done", surveys_swept=surveys_swept)
        else:
            logger.debug("response_tagging_backlog_sweep_noop")
        return {"enabled": True, "surveys_swept": surveys_swept}
    except Exception as exc:
        logger.warning("response_tagging_backlog_sweep_failed", error=str(exc))
        return {"enabled": True, "surveys_swept": surveys_swept, "error": str(exc)}


async def run_scheduler_once() -> None:
    """Run a single scheduler tick (useful for testing and inline embedding).

    Fixed 2026-07-04: zombie sweep and the CX SLA-breach sweep used to be gated
    here too, which meant neither could ever run faster than SCHEDULER_POLL_SEC —
    invisible in dev/staging (POLL_SEC=300s, ≤ both jobs' own 5-min interval) but
    a real bug in prod (POLL_SEC=3600s): the CX SLA-breach sweep is what escalates
    a customer support case once it's breached its SLA (Slack alert + reassignment),
    so nesting it here meant a breached case could sit unescalated for up to ~55
    extra minutes beyond its documented 5-minute window. Both now run on their own
    independent-cadence background loops (_run_zombie_sweep_loop /
    _run_cx_sla_breach_loop, started from run_scheduler()) instead of being gated
    by this function's own tick.
    """
    global _org_aggregation_last_run, _sla_check_last_run, _skill_quality_last_run
    global _feedback_rollup_last_run, _quality_sla_last_run, _gap_cluster_last_run
    global _retention_last_run, _response_tagging_backlog_last_run

    # Always clean up stale runs first so they don't block re-triggering.
    await _recover_stale_runs()
    await _auto_close_by_date()
    await _auto_close_by_response_count()

    now = time.time()

    # Org aggregation runs hourly
    if now - _org_aggregation_last_run >= _ORG_AGGREGATION_INTERVAL_SEC:
        await run_org_aggregation()
        _org_aggregation_last_run = now

    # SLA breach check runs every 15 minutes
    if now - _sla_check_last_run >= _SLA_CHECK_INTERVAL_SEC:
        await _check_sla_breaches()
        _sla_check_last_run = now

    # Nightly skill quality aggregation + low-quality flagging
    if now - _skill_quality_last_run >= _SKILL_QUALITY_INTERVAL_SEC:
        await _aggregate_skill_quality()
        await _flag_low_quality_skills()
        _skill_quality_last_run = now

    # Hourly feedback rollup
    if now - _feedback_rollup_last_run >= _FEEDBACK_ROLLUP_INTERVAL_SEC:
        await _rollup_feedback_hour()
        _feedback_rollup_last_run = now

    # Nightly quality SLA compliance check
    if now - _quality_sla_last_run >= _QUALITY_SLA_INTERVAL_SEC:
        await _check_quality_sla_compliance()
        _quality_sla_last_run = now

    # Weekly capability gap clustering
    if now - _gap_cluster_last_run >= _GAP_CLUSTER_INTERVAL_SEC:
        await _cluster_capability_gaps()
        _gap_cluster_last_run = now

    # Nightly insight checkpoint retention/compaction (Phase 7; no-op unless enabled)
    if ENABLE_RETENTION_JOB and now - _retention_last_run >= _RETENTION_INTERVAL_SEC:
        await run_retention_job()
        _retention_last_run = now

    # Response tagging backlog sweep runs every 15 minutes (catches surveys not
    # currently receiving live traffic + any previously-failed tagging attempts)
    if (ENABLE_RESPONSE_TAGGING_BACKLOG_SWEEP
            and now - _response_tagging_backlog_last_run >= _RESPONSE_TAGGING_BACKLOG_INTERVAL_SEC):
        await run_response_tagging_backlog_sweep()
        _response_tagging_backlog_last_run = now

    surveys = await _get_surveys_due(INTERVAL_FREE_MIN)
    if surveys:
        logger.info("scheduler_batch", count=len(surveys))
        triggered = 0
        for survey in surveys:
            survey_id = survey["id"]
            current_count = await _get_current_response_count(survey_id)
            last_count = await _get_last_run_response_count(survey_id)
            if last_count is not None and current_count <= last_count:
                logger.info(
                    "scheduler_skip_no_new_responses",
                    survey_id=survey_id,
                    current_count=current_count,
                    last_run_count=last_count,
                )
                continue
            await _trigger_generation(survey_id, survey["org_id"])
            triggered += 1
            await asyncio.sleep(2)  # stagger requests

        # Snapshot org-level aggregates for all orgs managed this tick
        distinct_org_ids = list({s["org_id"] for s in surveys})
        try:
            async with _pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    for oid in distinct_org_ids:
                        await cur.execute(
                            """INSERT INTO org_metric_snapshots
                                   (org_id, captured_at, active_survey_count, total_responses, avg_nps)
                               SELECT
                                   %s, NOW(),
                                   COUNT(*) FILTER (WHERE status = 'active'),
                                   (SELECT COUNT(*)::int FROM responses WHERE org_id = %s),
                                   ROUND(AVG(nps_score)::numeric, 1)
                               FROM surveys
                               WHERE org_id = %s AND deleted_at IS NULL""",
                            (oid, oid, oid),
                        )
                await conn.commit()
            logger.info("scheduler_org_snapshots", org_count=len(distinct_org_ids))
        except Exception as exc:
            logger.warning("scheduler_org_snapshot_failed", error=str(exc))

        if not triggered:
            logger.debug("scheduler_idle_no_new_responses")
    else:
        logger.debug("scheduler_idle")


async def _run_zombie_sweep_loop() -> None:
    """Independent-cadence background loop for sweep_zombie_runs — decoupled
    (2026-07-04) from run_scheduler_once/SCHEDULER_POLL_SEC so it keeps its
    documented 5-minute cadence even when POLL_SEC is much slower (prod: 3600s).
    Runs forever; a single failed sweep is logged and retried next interval."""
    while True:
        try:
            await sweep_zombie_runs()
        except Exception as exc:
            logger.error("zombie_sweep_loop_error", error=str(exc))
        await asyncio.sleep(_ZOMBIE_SWEEP_INTERVAL_SEC)


async def _run_cx_sla_breach_loop() -> None:
    """Independent-cadence background loop for _cx_sla_breach_sweep — same fix
    as _run_zombie_sweep_loop, but higher-stakes: this is what escalates a
    customer support case once it's breached its SLA (Slack alert + case
    reassignment). Nesting it inside run_scheduler_once meant a breached case
    could sit unescalated for up to ~55 extra minutes beyond its documented
    5-minute window in prod (POLL_SEC=3600s). Runs forever; a single failed
    sweep is logged and retried next interval."""
    while True:
        try:
            await _cx_sla_breach_sweep()
        except Exception as exc:
            logger.error("cx_sla_breach_loop_error", error=str(exc))
        await asyncio.sleep(_CX_SLA_BREACH_INTERVAL_SEC)


async def run_scheduler() -> None:
    """Main scheduler loop."""
    await init_pool()
    logger.info(
        "scheduler_started",
        interval_free_min=INTERVAL_FREE_MIN,
        interval_paid_min=INTERVAL_PAID_MIN,
        poll_sec=POLL_SEC,
    )

    # Zombie sweep and CX SLA-breach escalation run on their own independent
    # cadence, not gated by the (much slower in prod) survey-due-check loop below.
    zombie_task = asyncio.create_task(_run_zombie_sweep_loop())
    cx_sla_breach_task = asyncio.create_task(_run_cx_sla_breach_loop())

    try:
        while True:
            # Liveness signal for the shared SchedulerHeartbeatStale alert.
            try:
                from crystalos.lib.metrics import scheduler_heartbeat
                scheduler_heartbeat.labels(component="crystalos_scheduler").set(time.time())
            except Exception:
                pass

            try:
                await run_scheduler_once()
            except Exception as exc:
                logger.error("scheduler_loop_error", error=str(exc))

            await asyncio.sleep(POLL_SEC)
    finally:
        zombie_task.cancel()
        cx_sla_breach_task.cancel()
        await asyncio.gather(zombie_task, cx_sla_breach_task, return_exceptions=True)
        await close_pool()


if __name__ == "__main__":
    asyncio.run(run_scheduler())
