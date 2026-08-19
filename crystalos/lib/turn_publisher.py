"""Publishes structured Crystal turn events for telemetry and quality improvement.

Every Crystal interaction is captured as a TurnEvent and written asynchronously
to crystal_turn_events. Writes are fire-and-forget — telemetry failures never
propagate to callers.

Part of Enterprise CrystalOS redesign — Phase 3 (Observability).
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass

from crystalos.crystal.context import CrystalContext
from crystalos.lib.db import _pool_conn
from crystalos.lib.logger import logger


# ---------------------------------------------------------------------------
# TurnEvent dataclass
# ---------------------------------------------------------------------------

@dataclass
class TurnEvent:
    # Minted by the caller (agents/crystal.py) BEFORE the SSE `answer` frame /
    # REST response ships, so the client-visible turn_id and this row's real
    # primary key are the same value — see MIGRATION_PLAN.md §4 blocker #1.
    id:              str
    org_id:          str
    brand_id:        str | None
    user_id:         str
    survey_id:       str | None
    thread_id:       str | None        # nullable — telemetry fires before thread exists
    turn_index:      int
    query:           str
    tools_called:    list[dict]
    tool_errors:     list[dict]
    eval_score:      float | None
    model_used:      str | None
    tokens_in:       int
    tokens_out:      int
    latency_ms:      int
    specialist_used: str | None
    skill_name:      str | None = None  # skill that handled this turn
    quality_signal:  str | None = None
    # Which CrystalOS build produced this turn. Callers should set this from
    # `crystalos.lib.constants.CRYSTALOS_VERSION` — defaults to None so any
    # existing caller that doesn't pass it keeps working unchanged.
    crystalos_version: str | None = None


# ---------------------------------------------------------------------------
# Quality signal detection
# ---------------------------------------------------------------------------

_FRUSTRATION: list[str] = [
    "that's wrong", "incorrect", "not what i asked", "try again",
    "that's not right", "you're wrong", "that doesn't make sense",
    "that's not helpful", "stop", "nevermind", "forget it",
]
_SATISFACTION: list[str] = [
    "perfect", "exactly", "great", "thanks", "helpful",
    "that's what i needed", "good job", "nice", "awesome",
    "thank you", "excellent",
]


def detect_quality_signal(query: str) -> str | None:
    """Return 'positive', 'negative', or None based on sentiment keywords in the query."""
    q = query.lower()
    if any(p in q for p in _FRUSTRATION):
        return "negative"
    if any(p in q for p in _SATISFACTION):
        return "positive"
    return None


# ---------------------------------------------------------------------------
# DB write helpers (internal — never called directly by callers)
# ---------------------------------------------------------------------------

async def _write_turn_event(event: TurnEvent, ctx: CrystalContext) -> None:
    """Write a TurnEvent to crystal_turn_events.  Never raises."""
    try:
        async with _pool_conn().connection() as conn:
            await conn.execute(
                """INSERT INTO crystal_turn_events
                   (id, org_id, brand_id, user_id, survey_id, thread_id, turn_index,
                    query, tools_called, tool_errors, eval_score, model_used,
                    tokens_in, tokens_out, latency_ms, specialist_used, skill_name,
                    quality_signal, crystalos_version)
                   VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb,
                           %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    # Explicit id — skips the column's DEFAULT gen_random_uuid()
                    # rather than relying on it, so this row's PK is the exact
                    # value already handed to the client.
                    event.id,
                    event.org_id,
                    event.brand_id,
                    event.user_id,
                    event.survey_id,
                    event.thread_id,
                    event.turn_index,
                    event.query,
                    json.dumps(event.tools_called),
                    json.dumps(event.tool_errors),
                    event.eval_score,
                    event.model_used,
                    event.tokens_in,
                    event.tokens_out,
                    event.latency_ms,
                    event.specialist_used,
                    event.skill_name,
                    event.quality_signal,
                    event.crystalos_version,
                ),
            )
    except Exception as exc:
        logger.warning("turn_event_publish_failed", error=str(exc))
        # Telemetry is non-blocking — never propagate this error


def publish_turn_event(event: TurnEvent, ctx: CrystalContext) -> None:
    """Fire-and-forget telemetry write.

    Creates an asyncio task that writes to the DB in the background.
    Never raises — safe to call anywhere in the Crystal response path.
    """
    try:
        asyncio.create_task(_write_turn_event(event, ctx))
    except Exception as exc:
        logger.warning("publish_turn_event_schedule_failed", error=str(exc))


# ---------------------------------------------------------------------------
# Update previous turn quality signal
# ---------------------------------------------------------------------------

async def _update_previous_turn_quality(thread_id: str, turn_index: int, quality_signal: str) -> None:
    """Update the quality_signal on the most recent prior turn in a thread. Never raises."""
    try:
        async with _pool_conn().connection() as conn:
            await conn.execute(
                """UPDATE crystal_turn_events
                   SET quality_signal = %s
                   WHERE thread_id = %s
                     AND turn_index = %s""",
                (quality_signal, thread_id, turn_index),
            )
    except Exception as exc:
        logger.warning("update_previous_turn_quality_failed", error=str(exc))


# ---------------------------------------------------------------------------
# Capability gap logger
# ---------------------------------------------------------------------------

async def _write_capability_gap(ctx: CrystalContext, query: str, embedding: list[float] | None) -> None:
    """Write a capability gap entry to crystal_capability_gaps. Never raises."""
    try:
        async with _pool_conn().connection() as conn:
            await conn.execute(
                """INSERT INTO crystal_capability_gaps
                   (org_id, brand_id, user_id, survey_id, query, embedding, created_at)
                   VALUES (%s, %s, %s, %s, %s, %s::vector, NOW())""",
                (
                    ctx.org_id,
                    ctx.brand.brand_id if ctx.brand else None,
                    ctx.user_id,
                    ctx.survey_id,
                    query,
                    json.dumps(embedding) if embedding else None,
                ),
            )
    except Exception as exc:
        logger.warning("capability_gap_write_failed", error=str(exc))


async def log_capability_gap(ctx: CrystalContext, query: str) -> None:
    """Fire-and-forget: embed the query and write to crystal_capability_gaps."""
    try:
        from crystalos.tools.embeddings import embed_texts
        embeddings = await embed_texts([query], org_id=ctx.org_id, survey_id=ctx.survey_id or "")
        embedding = embeddings[0] if embeddings else None
    except Exception as exc:
        logger.warning("capability_gap_embed_failed", error=str(exc))
        embedding = None

    asyncio.create_task(_write_capability_gap(ctx, query, embedding))
