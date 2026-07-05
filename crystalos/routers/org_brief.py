"""Org Brief router — CrystalOS Org Intelligence Dashboard (Command Center).

POST /graphs/org-brief
  Triggers org_brief_graph.py's LangGraph DAG to generate (or regenerate) one
  org-level Crystal brief, then synchronously runs the post-publish
  verify_and_score step (Decision 16, item 5 — deliberately NOT a graph node;
  see crystalos/lib/org_brief_verify.py's module docstring).

Not registered in crystalos/main.py by this change — see
crystalos/routers/ORG_BRIEF_REGISTRATION_TODO.md for the exact lines a
separate integration pass should add (per IMPLEMENTATION_SPEC.md's file
ownership: "Registration line in crystalos/main.py (single-line addition,
coordinate).").
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from crystalos.graphs.org_brief_graph import build_org_brief_graph
from crystalos.lib.logger import logger
from crystalos.lib.org_brief_verify import verify_and_score
from crystalos.lib.security import require_internal_key

router = APIRouter(prefix="/api/crystal", tags=["org-brief"])

_GRAPH = None


def _get_graph():
    """Lazily build + cache the compiled graph (mirrors other routers' pattern
    of compiling once per process, not per request)."""
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_org_brief_graph()
    return _GRAPH


class OrgBriefRequest(BaseModel):
    org_id: str
    date_range_start: str
    date_range_end: str
    period_type: Literal["weekly", "custom"] = "weekly"
    requested_by: str | None = None


@router.post("/graphs/org-brief", summary="Generate (or regenerate) an org-level Crystal brief")
async def generate_org_brief(
    body: OrgBriefRequest,
    _key: None = Depends(require_internal_key),
) -> dict:
    graph = _get_graph()
    try:
        result = await graph.ainvoke({
            "org_id": body.org_id,
            "date_range_start": body.date_range_start,
            "date_range_end": body.date_range_end,
            "period_type": body.period_type,
            "requested_by": body.requested_by,
        })
    except Exception as exc:
        logger.error("org_brief_graph_failed", org_id=body.org_id, error=str(exc))
        raise HTTPException(status_code=500, detail="org_brief_generation_failed") from exc

    brief_id = result.get("brief_id")
    if not brief_id:
        logger.error("org_brief_graph_no_brief_id", org_id=body.org_id)
        raise HTTPException(status_code=500, detail="org_brief_generation_failed")

    # Post-publish step (Decision 16 item 5) — runs synchronously, after the
    # row already exists. A failure here is logged but never surfaced as a
    # 5xx to the caller — the brief itself published successfully.
    try:
        table = "org_custom_summaries" if body.period_type == "custom" else "org_crystal_briefs"
        source_insight_ids = [
            insight_id
            for rec in (result.get("recommendations") or [])
            for insight_id in (rec.get("source_insight_ids") or [])
        ]
        await verify_and_score(
            brief_id=brief_id,
            narrative=result.get("narrative", ""),
            recommendations=result.get("recommendations") or [],
            input_snapshot=result.get("input_snapshot") or {},
            org_signals=result.get("org_signals") or [],
            source_insight_ids=source_insight_ids,
            table=table,
        )
    except Exception as exc:
        logger.error("org_brief_verify_step_failed", brief_id=brief_id, error=str(exc))

    return {
        "brief_id": brief_id,
        "status": "complete",
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
