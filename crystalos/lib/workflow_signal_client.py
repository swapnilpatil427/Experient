"""Outbound `workflow_signal` emitter — CrystalOS → Node backend.

Delivery mechanism (per docs/automation-hub/WORKFLOW_SIGNAL_CONTRACT.md §2,
authored by Nina Reeves, backend seam owner — this module implements CrystalOS's
half against HER already-built and tested receiver, not a fresh design):

    POST {BACKEND_INTERNAL_URL}/api/internal/workflows/signal
    Auth: X-Internal-Key: AGENTS_INTERNAL_KEY (same shared secret used in the
          other direction for require_internal_key; service-to-service, no
          Clerk session)
    Body: { org_id, signal_type, confidence, payload, survey_id, detected_at,
            source_run_id }  (snake_case — see contract doc §2.3.2)
    → 202 { accepted: true, published: bool }

This call is fire-and-forget from the pipeline's perspective: it must NEVER
raise into `node_ai_triggers` / `run_insight_generation`. A signal that fails
to deliver is a missed automation opportunity (logged + counted), not a pipeline
failure — the insight run itself already succeeded and published by the time
this runs.
"""
from __future__ import annotations

import os
from typing import Any

import httpx

from crystalos.lib.logger import logger

BACKEND_INTERNAL_URL = os.getenv("BACKEND_INTERNAL_URL", "http://localhost:3001")
_INTERNAL_KEY = os.getenv("AGENTS_INTERNAL_KEY", "dev-internal-key-change-in-prod")
_SIGNAL_PATH = "/api/internal/workflows/signal"
_TIMEOUT_SECONDS = 5.0  # short — this is best-effort telemetry, never worth blocking pipeline completion


async def emit_workflow_signal(
    *,
    org_id: str,
    signal_type: str,
    confidence: float,
    survey_id: str | None = None,
    detected_at: str | None = None,
    source_run_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> bool:
    """POST one `workflow_signal` to the backend. Returns True if the backend
    accepted AND durably queued it (202 {accepted:true, published:true}),
    False for any other outcome (never raises).
    """
    if not org_id or not signal_type:
        logger.warning("workflow_signal_missing_required_fields", org_id=org_id, signal_type=signal_type)
        return False

    body = {
        "org_id": org_id,
        "signal_type": signal_type,
        "confidence": confidence,
        "payload": payload or {},
        "survey_id": survey_id,
        "detected_at": detected_at,
        "source_run_id": source_run_id,
    }
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                f"{BACKEND_INTERNAL_URL}{_SIGNAL_PATH}",
                json=body,
                headers={"X-Internal-Key": _INTERNAL_KEY, "Content-Type": "application/json"},
            )
        if resp.status_code != 202:
            logger.warning(
                "workflow_signal_rejected",
                org_id=org_id, signal_type=signal_type, status=resp.status_code, body=resp.text[:300],
            )
            return False
        data = resp.json()
        published = bool(data.get("published"))
        if not published:
            logger.warning("workflow_signal_not_durably_queued", org_id=org_id, signal_type=signal_type)
        return published
    except Exception as exc:
        logger.warning("workflow_signal_delivery_failed", org_id=org_id, signal_type=signal_type, error=str(exc))
        return False
