"""Xperiq Copilot Agents — FastAPI application.

Endpoints:
  POST /orchestrate                                    — Start a survey creation run (async background)
  GET  /orchestrate/{run_id}/status                    — Poll run status + stream events
  POST /orchestrate/{run_id}/cancel                    — Cancel a running run (stops task + marks DB)
  POST /orchestrate/{run_id}/refine                    — Copilot chat: apply natural-language edits
  POST /orchestrate/{run_id}/skip-logic                — Add conditional branching to questions
  POST /orchestrate/{run_id}/questions                 — Add a new question
  DELETE /orchestrate/{run_id}/questions/{q_id}        — Remove a question
  PATCH /orchestrate/{run_id}/questions/{q_id}         — Update specific fields on a question
  POST /orchestrate/{run_id}/reorder                   — Reorder questions
  POST /orchestrate/{run_id}/apply-recommendation/{action_id} — Execute a recommendation action
  POST /prism/map                                      — Prism schema-mapper (field mapping proposals)
  POST /prism/taxonomy                                 — Prism taxonomy-mapper (topic-label reconciliation)
  POST /prism/parity                                   — Prism metric-parity (metric-gap explainer)
  POST /workflows/parse-nl                             — NL description → workflow graph (Xperiq Actions)
  GET  /agents/registry                                — List all agent manifests
  GET  /health
  GET  /metrics

Security:
  All non-health/metrics endpoints require X-Internal-Key header (HMAC comparison).
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from contextlib import asynccontextmanager
from typing import Any

import dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST
from prometheus_client.exposition import generate_latest

dotenv.load_dotenv()

# ── Startup validation ────────────────────────────────────────────────────────
_IS_PROD = os.getenv("AGENTS_ENV", "dev").lower() == "production"

# Model ID check — all envs, not just prod. Catches unknown IDs before any
# LLM call is made so the error is obvious in the startup log.
from crystalos.lib.models import validate_all_model_configs
validate_all_model_configs()

if _IS_PROD:
    _missing = [v for v in ("DATABASE_URL", "REDIS_URL", "OPENROUTER_API_KEY", "AGENTS_INTERNAL_KEY") if not os.getenv(v)]
    if _missing:
        raise RuntimeError(f"Missing required env vars: {', '.join(_missing)}")
    if os.getenv("AGENTS_INTERNAL_KEY") == "dev-internal-key-change-in-prod":
        raise RuntimeError("AGENTS_INTERNAL_KEY must be changed from the default before deploying to production")
else:
    if os.getenv("AGENTS_INTERNAL_KEY", "dev-internal-key-change-in-prod") == "dev-internal-key-change-in-prod":
        print("⚠  CrystalOS DEV MODE — using default AGENTS_INTERNAL_KEY. Set AGENTS_INTERNAL_KEY before deploying to production.")  # noqa: T201
    if not os.getenv("OPENROUTER_API_KEY"):
        print("⚠  CrystalOS DEV MODE — no OPENROUTER_API_KEY. LLM calls will fail.")  # noqa: T201

from crystalos.agents import (
    ACTIVE_AGENTS, ALL_AGENTS,
    survey_creator_agent,
    copilot_agent,
    skip_logic_agent,
    refiner_agent,
    recommender_agent,
)
from crystalos.lib import db
from crystalos.lib import run_registry
from crystalos.lib.checkpointer import get_checkpointer
from crystalos.lib.logger import logger
from crystalos.lib.metrics import orchestration_runs_total
from crystalos.lib.security import require_internal_key, make_thread_id, sanitise_intent, sanitise_org_context
from crystalos.schemas.output import (
    OrchestrationRequest, OrchestrationResponse, RunStatusResponse,
    RefineRequest, RefineResponse,
    SkipLogicRequest,
    AddQuestionRequest, PatchQuestionRequest, ReorderRequest,
    ApplyRecommendationRequest, QuestionsResponse,
    RefinerInput, SkipLogicInput, CopilotInput, RecommenderInput,
    OrgContext, SessionAction,
)
from crystalos.schemas.question import Question
from crystalos.schemas.state import make_initial_state, make_stream_event
from crystalos.lib.credits import summarise_credits
from crystalos.lib.metrics import registry as metrics_registry
from crystalos.lib.validators import fix_question_ids


# ── Application state ────────────────────────────────────────────────────────────

_compiled_graph: Any = None


async def _run_scheduler_bg() -> None:
    """Thin wrapper so scheduler errors don't crash the lifespan."""
    try:
        from crystalos.scheduler import run_scheduler
        await run_scheduler()
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.error("scheduler_crashed", error=str(exc))


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _compiled_graph
    await db.init_pool()
    await db.ensure_schema()
    async with get_checkpointer() as checkpointer:
        from crystalos.graph import build_graph
        _compiled_graph = build_graph(checkpointer)

        # Optional inline scheduler (for single-process deploys)
        _scheduler_task = None
        if os.getenv("ENABLE_SCHEDULER", "").lower() == "true":
            _scheduler_task = asyncio.create_task(_run_scheduler_bg())
            logger.info("inline_scheduler_started")

        # Auto-enable when REDIS_URL is present; override with ENABLE_STREAM_CONSUMER=false to disable.
        _redis_url = os.getenv("REDIS_URL", "")
        _stream_default = "true" if _redis_url else "false"
        if os.getenv("ENABLE_STREAM_CONSUMER", _stream_default).lower() == "true":
            from crystalos.consumers.response_stream import run_response_stream_consumer
            from crystalos.consumers._redis import _REDIS_URL as _effective_redis_url
            asyncio.create_task(run_response_stream_consumer())
            logger.info("stream_consumer_enabled", redis_url=_effective_redis_url.split("@")[-1])

        _env = os.getenv("AGENTS_ENV", "dev")
        from crystalos.lib.models import _ROUTING, get_env
        _routing = _ROUTING[get_env()]
        _banner_rows = "\n".join(
            f"    {role:<18} {cfg.model}"
            for role, cfg in _routing.items()
            if role in ("creator", "qc", "qc_validator", "compliance", "recommender", "copilot")
        )
        print(
            f"\n{'─' * 58}\n"
            f"  Xperiq Agents  ·  AGENTS_ENV = {_env}\n"
            f"{'─' * 58}\n"
            f"{_banner_rows}\n"
            f"{'─' * 58}\n",
            flush=True,
        )
        logger.info("agents_service_ready", env=_env)

        # ── CrystalOS Skill Registry ─────────────────────────────────────────────
        from crystalos.lib.skill_registry import get_registry as get_skill_registry
        from crystalos.lib.tool_dispatcher import get_dispatcher
        _skill_reg = get_skill_registry()
        _dispatcher = get_dispatcher()
        _dispatcher.initialize()
        await _skill_reg.initialize()
        await _skill_reg.warm_router()
        logger.info("crystalos_skill_registry_ready", skill_count=len(_skill_reg.list_skills()))

        yield

        if _scheduler_task:
            _scheduler_task.cancel()
            try:
                await _scheduler_task
            except asyncio.CancelledError:
                pass

    # Flush Langfuse traces on shutdown
    try:
        from crystalos.lib.tracer import get_tracer
        get_tracer().flush()
    except Exception:
        pass

    await db.close_pool()
    logger.info("agents_service_shutdown")


# ── FastAPI app ──────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Xperiq Copilot Agents",
    version="2.0.0",
    description="Survey orchestration + editing microservice for Xperiq Copilot.",
    docs_url=None if _IS_PROD else "/docs",
    redoc_url=None,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for _agent in ACTIVE_AGENTS:
    app.include_router(_agent.build_router(), prefix="/agents")

from crystalos.routers.feedback import router as _feedback_router
from crystalos.routers.brand_admin import router as _brand_admin_router
app.include_router(_feedback_router)
app.include_router(_brand_admin_router)

from crystalos.lib.cdx import router as cdx_router
app.include_router(cdx_router)

from crystalos.routers.novu import router as novu_router
app.include_router(novu_router)

from crystalos.routers.org_brief import router as _org_brief_router
app.include_router(_org_brief_router)


# ── Helpers ──────────────────────────────────────────────────────────────────────

async def _require_run(run_id: str, org_id: str) -> dict:
    """Load a run row or raise 404. Raises 400 if org_id missing."""
    if not org_id:
        raise HTTPException(status_code=400, detail="org_id required")
    row = await db.get_run_by_id(run_id, org_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Run not found")
    return row


def _load_questions(row: dict) -> list[Question]:
    raw = row.get("result_questions") or []
    return [Question.model_validate(q) for q in raw]


def _questions_to_dicts(questions: list[Question]) -> list[dict]:
    return [q.model_dump(by_alias=True, exclude_none=True) for q in questions]


async def _fresh_recommendations(
    questions: list[Question],
    row: dict,
    org_context: OrgContext,
    survey_type_id: str | None,
    session_action: str,
) -> list[dict]:
    """Run the recommender on updated questions. Returns [] on any error so callers never fail."""
    try:
        inp = RecommenderInput(
            questions=questions,
            qc_score=float(row.get("qc_score") or 5.0),
            intent=row.get("intent", ""),
            org_context=org_context,
            survey_type_id=survey_type_id,
            session_actions=[SessionAction(action=session_action, context="applied via Copilot")],
        )
        output, _ = await recommender_agent.run(inp)
        return [r.model_dump() for r in output.recommendations]
    except Exception as exc:
        logger.warning("recommender_failed", session_action=session_action, error=str(exc))
        return []


# ── Recommendation action dispatcher ─────────────────────────────────────────────

_REFINE_ACTIONS   = {"refine_question", "review_in_builder"}
_SKIPLOGIC_ACTIONS = {"add_skip_logic", "add_piping_logic"}
_ADDQ_ACTIONS     = {"add_followup_question"}
_NOOP_ACTIONS     = {
    "run_pilot", "request_expert_review",
    "distribute_now", "schedule_send", "set_response_quota",
    "compare_previous_survey",
    "save_as_template", "set_expiry_date",
}
# Actions that have real handlers (not NOOPs):
#   check_compliance  → runs compliance-scanner skill
#   compare_template  → returns template list with guidance
#   add_skip_logic    → runs skip_logic_agent
#   refine_question   → runs refiner_agent / copilot_agent
#   add_followup_question → runs copilot_agent

async def _dispatch_recommendation(
    action_id: str,
    questions: list[Question],
    params: dict,
    org_context: OrgContext,
    survey_type_id: str | None,
    intent: str,
) -> tuple[list[Question], str]:
    """Route a recommendation action to the appropriate agent. Returns (questions, message)."""

    if action_id in _SKIPLOGIC_ACTIONS:
        request_text = params.get("request") or "Add skip logic where it improves the survey flow."
        inp = SkipLogicInput(questions=questions, request=request_text, org_context=org_context)
        output, _ = await skip_logic_agent.run(inp)
        return output.questions, output.summary

    if action_id in _REFINE_ACTIONS:
        q_id = params.get("question_id")
        feedback = params.get("feedback", "Improve this question for clarity and neutrality.")
        if q_id:
            target = next((q for q in questions if q.id == q_id), None)
            if target:
                from crystalos.schemas.output import RefinerInput
                inp = RefinerInput(
                    question_to_refine=target,
                    user_feedback=feedback,
                    survey_questions=questions,
                    org_context=org_context,
                )
                output, _ = await refiner_agent.run(inp)
                updated = [output.refined_question if q.id == q_id else q for q in questions]
                return updated, output.explanation
        # No specific question — use Copilot for general refinement
        inp = CopilotInput(
            questions=questions,
            message=f"Refine the survey for clarity and neutrality. {feedback}",
            org_context=org_context,
            survey_type_id=survey_type_id,
            intent=intent,
        )
        output, _ = await copilot_agent.run(inp)
        return output.questions, output.explanation

    if action_id in _ADDQ_ACTIONS:
        topic = str(params.get("topic", "a follow-up question to gather more context"))[:200].strip()
        inp = CopilotInput(
            questions=questions,
            message=f"Add {topic}",
            org_context=org_context,
            survey_type_id=survey_type_id,
            intent=intent,
        )
        output, _ = await copilot_agent.run(inp)
        return output.questions, output.explanation

    if action_id == "check_compliance":
        # Run the compliance-scanner CrystalOS skill
        try:
            from crystalos.lib.skill_registry import get_registry as _get_skill_reg
            _reg = _get_skill_reg()
            if _reg.is_initialized() and _reg.get_skill_meta("compliance-scanner"):
                result = await _reg.execute(
                    "compliance-scanner",
                    {
                        "questions": [q.model_dump() for q in questions],
                        "survey_intent": intent or "general survey",
                        "jurisdiction": None,
                        "collects_pii": None,
                    },
                    {},
                )
                output = result.get("output", {})
                score   = output.get("compliance_score", 0)
                passed  = output.get("passed", True)
                issues  = output.get("issues", [])
                critical = [i for i in issues if i.get("severity") == "critical"]
                major    = [i for i in issues if i.get("severity") == "major"]

                if passed and not critical:
                    risk = "low"
                    msg  = (
                        f"✓ Compliance scan complete. Score: {score}/100 — your survey looks good! "
                        f"No critical issues found."
                    )
                    if major:
                        msg += f" {len(major)} minor item(s) to review."
                elif critical:
                    risk = "high"
                    desc = "; ".join(i.get("description", "")[:80] for i in critical[:2])
                    msg  = (
                        f"Compliance scan complete. Score: {score}/100 — "
                        f"{len(critical)} critical issue(s) found: {desc}."
                    )
                else:
                    risk = "medium"
                    msg  = (
                        f"Compliance scan complete. Score: {score}/100 — "
                        f"{len(issues)} issue(s) to review before distributing."
                    )
                # Attach risk level as a special marker so the frontend badge shows
                return questions, f"[compliance_risk:{risk}] {msg}"
            else:
                return questions, "Compliance scanner is initializing. Please try again."
        except Exception as exc:
            logger.warning("check_compliance_failed", error=str(exc))
            return questions, "Compliance scan could not complete. Please try again."

    if action_id == "compare_template":
        # Return helpful guidance — template comparison requires the Template Library UI
        try:
            from crystalos.lib import db as _db
            rows = await _db.execute_query(
                """SELECT title, survey_type_id FROM templates
                   ORDER BY created_at DESC LIMIT 5""",
                (),
            )
            if rows:
                template_names = "\n".join(f"• {r[0]}" for r in rows[:5])
                msg = (
                    f"Found {len(rows)} template(s) available in your library:\n"
                    f"{template_names}\n\n"
                    f"Open the Template Library to compare your survey against these and apply one."
                )
            else:
                msg = (
                    "No custom templates in your library yet. "
                    "Browse the Template Library to find a starting point that matches your survey goals."
                )
        except Exception:
            msg = (
                "Open the Template Library to browse and compare templates for your survey type. "
                "Applying a template can provide proven question structure and best practices."
            )
        return questions, msg

    if action_id in _NOOP_ACTIONS:
        return questions, f"Action '{action_id}' recorded. No question changes needed."

    raise HTTPException(status_code=400, detail=f"Unknown recommendation action: {action_id}")


# ── Orchestration: create run ────────────────────────────────────────────────────

async def _run_graph_background(run_id: str, thread_id: str, initial_state: dict) -> None:
    config = {"configurable": {"thread_id": thread_id}}
    _success = False
    survey_id = initial_state.get("survey_id", "")
    org_id    = initial_state.get("org_id", "")
    trigger   = initial_state.get("trigger", "manual")

    # Langfuse top-level trace — groups all LLM calls for this pipeline run
    from crystalos.lib.tracer import get_tracer as _get_tracer
    _tracer = _get_tracer()

    with _tracer.trace(
        name=f"insight_pipeline:{trigger}",
        input={"survey_id": survey_id, "org_id": org_id, "trigger": trigger, "run_id": run_id},
        metadata={"run_id": run_id, "survey_id": survey_id},
    ) as _trace:
        try:
            accumulated_events:  list[dict] = []
            accumulated_credits: list[dict] = []
            total_tokens = 0
            cost_usd     = 0.0

            async for chunk in _compiled_graph.astream(initial_state, config, stream_mode="updates"):
                node_name   = next(iter(chunk))
                node_update = chunk[node_name] or {}

                events  = node_update.get("stream_events", [])
                credits = node_update.get("credit_log", [])
                accumulated_events  += events
                accumulated_credits += credits
                total_tokens  = node_update.get("total_tokens", total_tokens)
                cost_usd      = node_update.get("cost_usd", cost_usd)

                if events or credits:
                    await db.append_run_events(
                        run_id,
                        stream_events=events,
                        credit_log=credits,
                        total_tokens=total_tokens,
                        cost_usd=cost_usd,
                    )
                logger.debug("graph_node_complete", run_id=run_id, node=node_name)

            _success = True
            _trace.log_output({"status": "completed", "total_tokens": total_tokens, "cost_usd": cost_usd})

        except asyncio.CancelledError:
            _trace.log_error("Pipeline cancelled")
            logger.info("graph_task_cancelled", run_id=run_id)
            raise  # Must re-raise so asyncio marks the task as cancelled, not done normally.

        except Exception as e:
            import traceback as _tb
            error_type = type(e).__name__
            logger.error(
                "graph_background_error",
                run_id=run_id,
                error_type=error_type,    # ← UndefinedColumn, OpenRouterError, etc.
                error=str(e),
                traceback=_tb.format_exc(),
            )
            _trace.log_error(f"{error_type}: {str(e)[:500]}")
            try:
                await db.update_run(run_id, status="failed", error_log=[f"{error_type}: {str(e)}"])
            except Exception:
                pass

    if _success:
        # Delete the LangGraph checkpoint for this thread to prevent unbounded Postgres growth.
        # Failed/cancelled runs keep their checkpoint for debugging; successful runs don't need it.
        try:
            async with db._pool_conn().connection() as conn:
                await conn.execute("DELETE FROM checkpoint_writes WHERE thread_id = %s", (thread_id,))
                await conn.execute("DELETE FROM checkpoint_blobs WHERE thread_id = %s", (thread_id,))
                await conn.execute("DELETE FROM checkpoints WHERE thread_id = %s", (thread_id,))
        except Exception as exc:
            logger.warning("checkpoint_cleanup_failed", thread_id=thread_id, error=str(exc))


def _on_graph_task_done(task: asyncio.Task, run_id: str) -> None:
    """Done callback: deregister the task and log any unhandled exception."""
    run_registry.deregister(run_id)
    if not task.cancelled() and task.exception() is not None:
        logger.warning("graph_task_unhandled_error", run_id=run_id,
                       error=str(task.exception()))


@app.post("/orchestrate", response_model=OrchestrationResponse,
          summary="Start a survey creation orchestration run")
async def start_orchestration(
    body: OrchestrationRequest,
    _key: None = Depends(require_internal_key),
) -> OrchestrationResponse:
    intent     = sanitise_intent(body.intent)
    org_ctx    = sanitise_org_context(body.org_context.model_dump())
    run_id     = str(uuid.uuid4())
    session_id = body.session_id or run_id
    thread_id  = make_thread_id(body.org_id, session_id)

    await db.create_run(
        run_id=run_id, thread_id=thread_id, org_id=body.org_id,
        user_id=body.user_id, intent=intent, survey_type_id=body.survey_type_id,
        run_type="survey_creation",
    )

    initial_state = make_initial_state(
        run_id=run_id, thread_id=thread_id, org_id=body.org_id,
        user_id=body.user_id, intent=intent,
        survey_type_id=body.survey_type_id, org_context=org_ctx,
        session_actions=[a.model_dump() for a in body.session_actions],
        survey_history=[h.model_dump() for h in body.survey_history],
    )

    task = asyncio.create_task(_run_graph_background(run_id, thread_id, initial_state))
    run_registry.register(run_id, task)
    task.add_done_callback(lambda t: _on_graph_task_done(t, run_id))

    orchestration_runs_total.labels(run_type="survey_creation", status="started").inc()
    logger.info("orchestration_started", run_id=run_id, org_id=body.org_id)
    return OrchestrationResponse(run_id=run_id, thread_id=thread_id, status="running")


@app.post("/orchestrate/{run_id}/cancel",
          summary="Cancel a running survey creation orchestration")
async def cancel_orchestration(
    run_id:  str,
    request: Request,
    _key:    None = Depends(require_internal_key),
) -> dict:
    org_id = request.query_params.get("org_id", "")
    row    = await _require_run(run_id, org_id)

    # Idempotent: already in a terminal state
    _TERMINAL = {"completed", "failed", "cancelled"}
    if row["status"] in _TERMINAL:
        return {"run_id": run_id, "status": row["status"], "task_cancelled": False}

    # Interrupt the in-process asyncio task (best-effort — may be False if on a
    # different worker or if the graph just finished between the check above and now)
    task_cancelled = run_registry.cancel(run_id)

    # DB update is the authoritative record regardless of task state
    await db.cancel_run(run_id, org_id)

    logger.info("orchestration_cancelled", run_id=run_id, org_id=org_id,
                task_cancelled=task_cancelled)
    orchestration_runs_total.labels(run_type="survey_creation", status="cancelled").inc()
    return {"run_id": run_id, "status": "cancelled", "task_cancelled": task_cancelled}


@app.get("/orchestrate/{run_id}/status", response_model=RunStatusResponse,
         summary="Poll run status and accumulated stream events")
async def get_run_status(
    run_id:  str,
    request: Request,
    _key:    None = Depends(require_internal_key),
) -> RunStatusResponse:
    org_id = request.query_params.get("org_id", "")
    row    = await _require_run(run_id, org_id)

    credit_summary = summarise_credits(row.get("credit_log") or [])
    questions_raw  = row.get("result_questions") or []
    errors         = row.get("error_log") or []

    return RunStatusResponse(
        run_id=str(row["id"]),
        thread_id=row["thread_id"],
        status=row["status"],
        stream_events=row.get("stream_events") or [],
        qc_score=row.get("qc_score"),
        compliance_risk=row.get("compliance_risk_level"),
        questions=questions_raw if questions_raw else None,
        recommendations=row.get("recommendations") or [],
        credit_summary=credit_summary,
        error=errors[-1] if errors else None,
        validation_warnings=row.get("qc_validation_errors") or [],
    )


# ── Run listing (all run types) ──────────────────────────────────────────────────

@app.get("/runs", summary="List all agent runs for an org")
async def list_runs(
    request: Request,
    _key:    None = Depends(require_internal_key),
) -> dict:
    org_id    = request.query_params.get("org_id", "")
    run_type  = request.query_params.get("run_type") or None
    status    = request.query_params.get("status") or None
    survey_id = request.query_params.get("survey_id") or None
    try:
        limit  = max(1, min(int(request.query_params.get("limit", "20")), 100))
        offset = max(0, min(int(request.query_params.get("offset", "0")), 10_000))
    except ValueError:
        raise HTTPException(status_code=400, detail="limit and offset must be integers")

    if not org_id:
        raise HTTPException(status_code=400, detail="org_id required")

    runs = await db.list_runs(
        org_id=org_id, run_type=run_type, status=status,
        survey_id=survey_id, limit=limit, offset=offset,
    )
    # Serialise datetime fields for JSON
    for r in runs:
        for k in ("created_at", "completed_at"):
            if r.get(k) is not None:
                r[k] = r[k].isoformat()
        if r.get("error_log") and not isinstance(r["error_log"], list):
            import json as _j
            r["error_log"] = _j.loads(r["error_log"])
    return {"runs": runs, "limit": limit, "offset": offset}


@app.get("/runs/{run_id}", summary="Get any agent run by ID")
async def get_run(
    run_id:  str,
    request: Request,
    _key:    None = Depends(require_internal_key),
) -> dict:
    org_id = request.query_params.get("org_id", "")
    row    = await _require_run(run_id, org_id)
    for k in ("created_at", "completed_at"):
        if row.get(k) is not None:
            row[k] = row[k].isoformat()
    return row


# ── Copilot chat: natural-language edits ─────────────────────────────────────────

@app.post("/orchestrate/{run_id}/refine", response_model=RefineResponse,
          summary="Apply a natural-language edit to survey questions via Copilot")
async def refine_survey(
    run_id: str,
    body:   RefineRequest,
    _key:   None = Depends(require_internal_key),
) -> RefineResponse:
    row = await _require_run(run_id, body.org_id)

    # Use frontend-provided questions when available — they reflect unsaved manual edits
    if body.questions:
        questions = body.questions
        # Sync current state to agents DB so subsequent calls stay consistent
        await db.save_run_questions(run_id, _questions_to_dicts(questions), body.org_id)
    else:
        questions = _load_questions(row)

    if not questions:
        raise HTTPException(status_code=422, detail="Run has no questions yet")

    inp = CopilotInput(
        questions=questions,
        message=sanitise_intent(body.message),
        org_context=body.org_context,
        survey_type_id=body.survey_type_id,
        intent=body.intent or row.get("intent", ""),
        conversation_history=body.conversation_history,
    )
    output, _ = await copilot_agent.run(inp)

    # MODE C — the LLM classified this as a recommendation request.
    # Don't apply survey changes; run the recommender and return cards instead.
    if output.response_type == "recommendations":
        recommendations = await _fresh_recommendations(
            questions, row, inp.org_context, body.survey_type_id,
            session_action="view_recommendations",
        )
        logger.info("copilot_recommendations_requested", run_id=run_id, org_id=body.org_id)
        return RefineResponse(
            questions=questions,
            explanation="Here are my recommendations for your survey:",
            changes=[],
            suggestions=[],
            recommendations=recommendations,
            response_type="answer",
        )

    # MODE B — survey edit applied.
    await db.save_run_questions(run_id, _questions_to_dicts(output.questions), body.org_id)
    logger.info("copilot_refine", run_id=run_id, org_id=body.org_id,
                changes=len(output.changes))

    recommendations = await _fresh_recommendations(
        output.questions, row, inp.org_context, body.survey_type_id,
        session_action="general_refine",
    )

    return RefineResponse(
        questions=output.questions,
        explanation=output.explanation,
        changes=output.changes,
        suggestions=output.suggestions,
        recommendations=recommendations,
        response_type=output.response_type,
    )


# ── Skip logic ───────────────────────────────────────────────────────────────────

@app.post("/orchestrate/{run_id}/skip-logic", response_model=QuestionsResponse,
          summary="Add conditional skip/display logic to survey questions")
async def add_skip_logic(
    run_id: str,
    body:   SkipLogicRequest,
    _key:   None = Depends(require_internal_key),
) -> QuestionsResponse:
    row       = await _require_run(run_id, body.org_id)
    questions = _load_questions(row)

    if not questions:
        raise HTTPException(status_code=422, detail="Run has no questions yet")

    inp    = SkipLogicInput(questions=questions, request=body.request, org_context=body.org_context)
    output, _ = await skip_logic_agent.run(inp)

    await db.save_run_questions(run_id, _questions_to_dicts(output.questions), body.org_id)
    logger.info("skip_logic_added", run_id=run_id, changes=len(output.changes))

    return QuestionsResponse(
        questions=output.questions,
        message=output.summary,
        changes=[c.model_dump() for c in output.changes],
    )


# ── Question CRUD ────────────────────────────────────────────────────────────────

@app.post("/orchestrate/{run_id}/questions", response_model=QuestionsResponse,
          summary="Add a new question to the survey")
async def add_question(
    run_id: str,
    body:   AddQuestionRequest,
    _key:   None = Depends(require_internal_key),
) -> QuestionsResponse:
    row       = await _require_run(run_id, body.org_id)
    questions = _load_questions(row)

    # Determine next ID
    existing_nums = []
    for q in questions:
        try:
            existing_nums.append(int(q.id.lstrip("q")))
        except ValueError:
            pass
    next_num = max(existing_nums, default=0) + 1
    new_id   = f"q{next_num}"

    new_q = Question(id=new_id, type=body.type, question="New question", required=True)

    if body.after_id:
        idx = next((i for i, q in enumerate(questions) if q.id == body.after_id), None)
        if idx is not None:
            questions.insert(idx + 1, new_q)
        else:
            questions.append(new_q)
    else:
        questions.append(new_q)

    await db.save_run_questions(run_id, _questions_to_dicts(questions), body.org_id)
    logger.info("question_added", run_id=run_id, q_id=new_id, type=body.type)

    return QuestionsResponse(
        questions=questions,
        message=f"Added {body.type} question {new_id}",
        changes=[{"question_id": new_id, "what_changed": "added"}],
    )


@app.delete("/orchestrate/{run_id}/questions/{q_id}", response_model=QuestionsResponse,
            summary="Remove a question from the survey")
async def remove_question(
    run_id: str,
    q_id:   str,
    request: Request,
    _key:   None = Depends(require_internal_key),
) -> QuestionsResponse:
    org_id    = request.query_params.get("org_id", "")
    row       = await _require_run(run_id, org_id)
    questions = _load_questions(row)

    before = len(questions)
    # Remove the question and any skip logic rules that reference it
    updated = []
    for q in questions:
        if q.id == q_id:
            continue
        if q.skipLogic:
            q.skipLogic = [r for r in q.skipLogic if r.destination != q_id] or None
        if q.displayLogic and q.displayLogic.sourceQuestionId == q_id:
            q.displayLogic = None
        updated.append(q)

    if len(updated) == before:
        raise HTTPException(status_code=404, detail=f"Question {q_id} not found")

    await db.save_run_questions(run_id, _questions_to_dicts(updated), org_id)
    logger.info("question_removed", run_id=run_id, q_id=q_id)

    return QuestionsResponse(
        questions=updated,
        message=f"Removed question {q_id}",
        changes=[{"question_id": q_id, "what_changed": "removed"}],
    )


@app.patch("/orchestrate/{run_id}/questions/{q_id}", response_model=QuestionsResponse,
           summary="Update specific fields on a question")
async def patch_question(
    run_id: str,
    q_id:   str,
    body:   PatchQuestionRequest,
    _key:   None = Depends(require_internal_key),
) -> QuestionsResponse:
    row       = await _require_run(run_id, body.org_id)
    questions = _load_questions(row)

    target_idx = next((i for i, q in enumerate(questions) if q.id == q_id), None)
    if target_idx is None:
        raise HTTPException(status_code=404, detail=f"Question {q_id} not found")

    # Security boundary: body.org_id is validated by _require_run above, which calls
    # db.get_run_by_id(run_id, org_id) — this ensures the run belongs to the org.
    # The Node.js copilot.js route extracts req.orgId from the verified Clerk JWT and
    # passes it here, so org_id is always org-scoped before reaching this service.
    # Merge fields — never allow ID or type to be changed via patch (use Refiner for type changes)
    safe_fields = {k: v for k, v in body.fields.items() if k not in ("id",)}
    q_dict = questions[target_idx].model_dump(by_alias=True)
    q_dict.update(safe_fields)

    try:
        questions[target_idx] = Question.model_validate(q_dict)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Invalid field values: {e}")

    await db.save_run_questions(run_id, _questions_to_dicts(questions), body.org_id)
    logger.info("question_patched", run_id=run_id, q_id=q_id, fields=list(safe_fields.keys()))

    return QuestionsResponse(
        questions=questions,
        message=f"Updated {q_id}: {', '.join(safe_fields.keys())}",
        changes=[{"question_id": q_id, "what_changed": f"patched: {list(safe_fields.keys())}"}],
    )


@app.post("/orchestrate/{run_id}/reorder", response_model=QuestionsResponse,
          summary="Reorder questions by providing a new ordered list of IDs")
async def reorder_questions(
    run_id: str,
    body:   ReorderRequest,
    _key:   None = Depends(require_internal_key),
) -> QuestionsResponse:
    row       = await _require_run(run_id, body.org_id)
    questions = _load_questions(row)

    q_map = {q.id: q for q in questions}
    missing = [qid for qid in body.order if qid not in q_map]
    if missing:
        raise HTTPException(status_code=422, detail=f"Unknown question IDs: {missing}")

    reordered = [q_map[qid] for qid in body.order]
    # Append any questions not listed in the order at the end
    listed = set(body.order)
    reordered += [q for q in questions if q.id not in listed]

    await db.save_run_questions(run_id, _questions_to_dicts(reordered), body.org_id)
    logger.info("questions_reordered", run_id=run_id, order=body.order)

    return QuestionsResponse(
        questions=reordered,
        message=f"Reordered {len(body.order)} questions",
        changes=[{"question_id": qid, "what_changed": f"moved to position {i+1}"}
                 for i, qid in enumerate(body.order)],
    )


# ── Recommendation dispatcher ────────────────────────────────────────────────────

@app.post("/orchestrate/{run_id}/apply-recommendation/{action_id}",
          response_model=QuestionsResponse,
          summary="Execute a recommendation action (skip logic, refine, add question, etc.)")
async def apply_recommendation(
    run_id:    str,
    action_id: str,
    body:      ApplyRecommendationRequest,
    _key:      None = Depends(require_internal_key),
) -> QuestionsResponse:
    row       = await _require_run(run_id, body.org_id)
    questions = _load_questions(row)

    updated, message = await _dispatch_recommendation(
        action_id=action_id,
        questions=questions,
        params=body.parameters,
        org_context=body.org_context,
        survey_type_id=body.survey_type_id,
        intent=body.intent or row.get("intent", ""),
    )

    if updated is not questions:
        await db.save_run_questions(run_id, _questions_to_dicts(updated), body.org_id)

    logger.info("recommendation_applied", run_id=run_id, action=action_id, org_id=body.org_id)

    # Extract compliance_risk from special "[compliance_risk:X] message" marker
    compliance_risk: str | None = None
    import re as _re
    _cr_match = _re.match(r"^\[compliance_risk:(\w+)\]\s*", message)
    if _cr_match:
        compliance_risk = _cr_match.group(1)
        message = message[_cr_match.end():]          # strip the marker from displayed text

    recommendations = await _fresh_recommendations(
        updated, row, body.org_context, body.survey_type_id,
        session_action=action_id,
    )

    return QuestionsResponse(
        questions=updated,
        message=message,
        changes=[{"action": action_id, "applied": True}],
        recommendations=recommendations,
        compliance_risk=compliance_risk,
    )


# ── Insight generation ───────────────────────────────────────────────────────────

@app.post("/insights/generate", summary="Kick off insight generation for a survey")
async def generate_insights(
    request: Request,
    _: None = Depends(require_internal_key),
) -> dict:
    body      = await request.json()
    survey_id = body.get("survey_id")
    org_id    = body.get("org_id")
    run_id    = body.get("run_id")
    trigger   = body.get("trigger", "schedule")
    if not all([survey_id, org_id, run_id]):
        raise HTTPException(status_code=422, detail="survey_id, org_id, run_id required")

    from crystalos.graphs.insights import run_insight_generation
    task = asyncio.create_task(run_insight_generation(survey_id, org_id, run_id, trigger))
    task.add_done_callback(
        lambda t: logger.warning("insight_task_unhandled_error", run_id=run_id, error=str(t.exception()))
        if t.exception() else None
    )
    return {"status": "started", "run_id": run_id}


# ── Manual / refresh insight runs (Insight Pipeline v2 — Phase 3) ─────────────────

_MANUAL_MODE_TO_PROFILE = {
    "expert":  "manual_expert",
    "quick":   "manual_quick",
    "refresh": "refresh",
}


@app.post("/insights/runs", summary="Start a manual or refresh insight run for a survey")
async def start_insight_run(
    request: Request,
    _: None = Depends(require_internal_key),
) -> dict:
    """Trigger a manual (expert/quick) or refresh insight run.

    The Node backend POSTs here with the internal key after creating the agent_runs
    row (run_id) and debiting credits on its own /runs path. Body:
      { survey_id, org_id, run_id, mode: "expert"|"quick"|"refresh",
        window_start?, window_end?, label?, actor }

    For manual modes an insight_reports row is created immediately as status
    'generating' so the report_id is discoverable before the run completes; the
    pipeline flips it to 'ready' at publish. Returns {run_id, status, report_id?}.
    """
    body      = await request.json()
    survey_id = body.get("survey_id")
    org_id    = body.get("org_id")
    run_id    = body.get("run_id")
    mode      = (body.get("mode") or body.get("profile") or "").strip()
    if not all([survey_id, org_id, run_id]):
        raise HTTPException(status_code=422, detail="survey_id, org_id, run_id required")

    profile = _MANUAL_MODE_TO_PROFILE.get(mode, mode)
    from crystalos.lib.constants import INSIGHT_PROFILES
    if profile not in INSIGHT_PROFILES or profile == "automated_incremental":
        raise HTTPException(
            status_code=422,
            detail="mode must be one of: expert, quick, refresh",
        )

    window_start = body.get("window_start")
    window_end   = body.get("window_end")
    label        = body.get("label")
    actor        = body.get("actor") or "user:unknown"
    trigger      = "refresh" if profile == "refresh" else "manual"
    sample_cap   = body.get("sample_cap")  # optional int: override corpus cap for this run

    # ── Credit pre-flight (read-only; backend owns debiting) ──────────────────
    # For manual/refresh, raise 402 when insufficient (defence-in-depth). Balance
    # unknown (dev / no ledger) → proceeds.
    try:
        from crystalos.lib.insight_settings import (
            load_insight_settings, credit_preflight, InsufficientCreditsError,
        )
        settings = await load_insight_settings(survey_id, org_id)
        try:
            await credit_preflight(org_id, profile, settings)
        except InsufficientCreditsError as ice:
            raise HTTPException(
                status_code=402,
                detail={"error": "insufficient_credits",
                        "required": ice.required, "available": ice.available},
            )
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("insight_run_preflight_failed", run_id=run_id, error=str(exc))

    # ── Create insight_reports row up-front for manual modes (discoverable id) ─
    report_id = None
    if profile in ("manual_expert", "manual_quick"):
        try:
            from crystalos.lib import db as _db
            async with _db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """INSERT INTO insight_reports
                             (survey_id, org_id, run_id, run_mode, label,
                              window_start, window_end, created_by, status)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'generating')
                           ON CONFLICT (run_id) DO UPDATE SET status='generating'
                           RETURNING id""",
                        (survey_id, org_id, run_id, profile, label,
                         window_start, window_end, actor),
                    )
                    row = await cur.fetchone()
                    report_id = str(row[0]) if row else None
                await conn.commit()
        except Exception as exc:
            logger.warning("insight_run_report_precreate_failed", run_id=run_id, error=str(exc))

    config_override: dict = {}
    if label:
        config_override["label"] = label
    if report_id:
        config_override["report_id"] = report_id
    if sample_cap is not None:
        try:
            _cap = int(sample_cap)
            # Override both manual_expert and manual_quick caps so resolve_context
            # honours the caller-specified cap regardless of profile.
            config_override["manual_expert_full_corpus_cap"] = _cap
            config_override["manual_expert_max_corpus"]      = _cap
            config_override["manual_quick_sample_cap"]       = _cap
        except (TypeError, ValueError):
            pass

    from crystalos.graphs.insights import run_insight_generation
    task = asyncio.create_task(run_insight_generation(
        survey_id, org_id, run_id, trigger,
        profile=profile, window_start=window_start, window_end=window_end,
        config_override=config_override or None, actor=actor,
    ))
    task.add_done_callback(
        lambda t: logger.warning("insight_run_unhandled_error", run_id=run_id, error=str(t.exception()))
        if t.exception() else None
    )
    resp = {"status": "started", "run_id": run_id, "profile": profile}
    if report_id:
        resp["report_id"] = report_id
    return resp


@app.post("/topics/backfill", summary="Start a manual topic-tagging backfill job for a survey")
async def start_topic_backfill(
    request: Request,
    _: None = Depends(require_internal_key),
) -> dict:
    """Drain a survey's entire untagged-response backlog on demand (Experience →
    Topics page "Backfill Tagging" button).

    The Node backend POSTs here with the internal key after inserting the
    agent_runs row (run_type='topic_backfill') and debiting credits on its own
    route — same division of responsibility as /insights/runs above: Node owns
    the row, this endpoint only starts the background task that updates it.
    Body: { survey_id, org_id, run_id }. Returns {status, run_id} immediately;
    lib/topic_backfill.py::run_topic_backfill reports progress into the SAME
    agent_runs row via stream_events, pollable at GET /api/runs/:runId.
    """
    body      = await request.json()
    survey_id = body.get("survey_id")
    org_id    = body.get("org_id")
    run_id    = body.get("run_id")
    if not all([survey_id, org_id, run_id]):
        raise HTTPException(status_code=422, detail="survey_id, org_id, run_id required")

    from crystalos.lib.topic_backfill import run_topic_backfill
    task = asyncio.create_task(run_topic_backfill(run_id, survey_id, org_id))
    task.add_done_callback(
        lambda t: logger.warning("topic_backfill_unhandled_error", run_id=run_id, error=str(t.exception()))
        if t.exception() else None
    )
    return {"status": "started", "run_id": run_id}


# ── Workflow NL parsing (Xperiq Actions Wave 3) ───────────────────────────────

@app.post("/workflows/parse-nl", summary="Parse a natural-language description into a workflow graph")
async def parse_workflow_nl_endpoint(
    request: Request,
    _: None = Depends(require_internal_key),
) -> dict:
    """Turn a plain-English workflow description into an engine-ready graph.

    The Node backend's `POST /api/workflows/parse-nl` proxy calls this with the
    internal key, forwarding its own `workflowRegistry.ts` catalog as `registry`
    so there is exactly one source of truth for valid triggers/condition-fields/
    actions (this service never hand-maintains a duplicate copy). Body:
      { description: str, org_id: str, registry: { triggers, conditionFields,
        conditionOperators, actions, surveys?, tags? } }

    `registry.surveys`/`registry.tags` (Wave 12 — BUILDER_REDESIGN_V2_SCOPE.md,
    optional): [{id, name}] — the org's real surveys/tags, used to resolve the
    LLM draft's free-text scope mention onto a real id. Absent on older callers
    (or the legacy chat-tool's FALLBACK_REGISTRY) — scope simply always
    resolves to org in that case, same as before this list existed.

    Returns 200 with { name, description, triggerType, nodes, edges, confidence,
    warnings, scopeType, scopeSurveyId, scopeTagId } on a usable parse
    (including low-confidence — the frontend decides how to render below its
    own threshold), or 422 with a FLAT (non-nested) { error: 'unparseable',
    message, suggestions } body.

    scopeType/scopeSurveyId/scopeTagId default to 'org'/null/null whenever the
    description doesn't name a real survey/tag — IDENTICAL to this endpoint's
    pre-Wave-12 behavior (every NL workflow was implicitly org-wide). Scope
    inference is purely additive; see `workflow_nl._resolve_scope_hint` for the
    conservative matching rule (exact match, or unambiguous substring match
    only — never a guess when a hint could plausibly mean more than one thing).

    NOTE on the 422 shape: this deliberately returns `JSONResponse` directly
    rather than `raise HTTPException(422, detail={...})`. FastAPI always wraps
    `HTTPException.detail` under a top-level `"detail"` key on the wire
    (`{"detail": {...}}`), but the Node proxy (`agentsClient.parseWorkflowNL`,
    per docs/automation-hub/WORKFLOW_SIGNAL_CONTRACT.md §1.3.2) re-parses the
    raw response body text expecting `message`/`suggestions` at the TOP level.
    A `detail`-wrapped body would silently degrade every unparseable/low-
    confidence response to a generic fallback message with an empty
    `suggestions` array — exactly the highest-risk mismatch that doc flags.
    """
    body = await request.json()
    description = (body.get("description") or "").strip()
    registry = body.get("registry") or {}
    org_id = body.get("org_id") or ""

    if not description or len(description) > 1000:
        return JSONResponse(
            status_code=422,
            content={
                "error": "unparseable",
                "message": "Description must be between 1 and 1000 characters.",
                "suggestions": [],
            },
        )

    logger.info("workflow_nl_parse_requested", org_id=org_id, description_length=len(description))
    from crystalos.crystal.workflow_nl import parse_workflow_nl
    result = await parse_workflow_nl(description, registry)

    if not result.ok:
        return JSONResponse(
            status_code=422,
            content={
                "error": "unparseable",
                "message": result.message,
                "suggestions": result.suggestions,
            },
        )

    return {
        "name": result.name,
        "description": result.description,
        "triggerType": result.trigger_type,
        "nodes": result.nodes,
        "edges": result.edges,
        "confidence": result.confidence,
        "warnings": result.warnings,
        "scopeType": result.scope_type,
        "scopeSurveyId": result.scope_survey_id,
        "scopeTagId": result.scope_tag_id,
    }


# ── Custom Analysis (Insight Pipeline v2 — Phase 6, fully isolated) ───────────────

@app.post("/reports/custom/run", summary="Run an isolated Custom Analysis for a survey")
async def run_custom_report(
    request: Request,
    _: None = Depends(require_internal_key),
) -> dict:
    """Start a fully-isolated Custom Analysis run (background task).

    The Node backend POSTs here with the internal key after creating the
    custom_reports row (report_id) + agent_runs row (run_id) and debiting credits.
    Body:
      { survey_id, org_id, run_id, report_id, filter_spec, actor }

    filter_spec = { date_from?, date_to?, segments?, topics?, metric_types?,
                    narrative_depth? }  (see 03 §10)

    Writes ONLY custom_reports + custom_report_insights — never the insights table,
    never supersedes, never mutates survey_topics. Returns { status, run_id, report_id }.
    """
    body       = await request.json()
    survey_id  = body.get("survey_id")
    org_id     = body.get("org_id")
    run_id     = body.get("run_id")
    report_id  = body.get("report_id") or body.get("custom_report_id")
    filter_spec = body.get("filter_spec") or {}
    actor      = body.get("actor") or "user:unknown"
    if not all([survey_id, org_id, run_id, report_id]):
        raise HTTPException(
            status_code=422,
            detail="survey_id, org_id, run_id, report_id required",
        )

    # ── Credit pre-flight (read-only; backend owns debiting) ──────────────────
    try:
        from crystalos.lib.insight_settings import (
            load_insight_settings, credit_preflight, InsufficientCreditsError,
        )
        settings = await load_insight_settings(survey_id, org_id)
        if settings.get("custom_analysis_enabled") is False:
            raise HTTPException(status_code=403, detail="custom_analysis_disabled")
        try:
            await credit_preflight(org_id, "custom", settings)
        except InsufficientCreditsError as ice:
            raise HTTPException(
                status_code=402,
                detail={"error": "insufficient_credits",
                        "required": ice.required, "available": ice.available},
            )
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("custom_report_preflight_failed", run_id=run_id, error=str(exc))

    from crystalos.graphs.custom_analysis import run_custom_analysis
    task = asyncio.create_task(run_custom_analysis(
        survey_id, org_id, run_id, report_id, filter_spec, actor,
    ))
    task.add_done_callback(
        lambda t: logger.warning("custom_report_unhandled_error", run_id=run_id,
                                 error=str(t.exception()))
        if not t.cancelled() and t.exception() else None
    )
    logger.info("custom_report_run_started", run_id=run_id, report_id=report_id,
                survey_id=survey_id, org_id=org_id)
    return {"status": "started", "run_id": run_id, "report_id": report_id}


# ── Group insight generation ─────────────────────────────────────────────────────

@app.post("/groups/insights/generate", summary="Kick off cross-survey group insight generation")
async def generate_group_insights(
    request: Request,
    _: None = Depends(require_internal_key),
) -> dict:
    """Start group insight generation for a tagged survey group.

    Body:
      run_id    — UUID of the group_insight_runs row (created by backend before calling this)
      tag_ids   — list of tag UUIDs defining the group
      survey_ids — list of survey UUIDs in the group (optional; derived from tag_ids if omitted)
      org_id    — organisation UUID

    Returns:
      { run_id, status: "running" }
    """
    body = await request.json()
    run_id     = body.get("run_id")
    tag_ids    = body.get("tag_ids") or []
    survey_ids = body.get("survey_ids") or []
    org_id     = body.get("org_id")

    if not all([run_id, org_id]) or not tag_ids:
        raise HTTPException(status_code=422, detail="run_id, org_id, and tag_ids required")

    # Mark the run as running in DB
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """UPDATE group_insight_runs
                       SET status = 'running', heartbeat_at = NOW()
                       WHERE id = %s AND org_id = %s""",
                    (run_id, org_id),
                )
            await conn.commit()
    except Exception as exc:
        logger.warning("group_insight_run_status_update_failed", run_id=run_id, error=str(exc))

    from crystalos.graphs.group_insights import run_group_insight_generation
    task = asyncio.create_task(
        run_group_insight_generation(tag_ids, survey_ids, org_id, run_id)
    )
    task.add_done_callback(
        lambda t: logger.warning("group_insight_task_unhandled_error", run_id=run_id,
                                 error=str(t.exception()))
        if not t.cancelled() and t.exception() else None
    )

    logger.info("group_insight_generation_started", run_id=run_id, org_id=org_id,
                tag_count=len(tag_ids))
    return {"run_id": run_id, "status": "running"}


@app.post("/tag-reports/generate", summary="Kick off a Tag Report cross-survey checkpoint rollup")
async def generate_tag_report(
    request: Request,
    _: None = Depends(require_internal_key),
) -> dict:
    """Start Tag Report generation for a tag (Manual / Automated / Custom Range).

    Tag Report NEVER generates fresh per-survey AI insight — it only rolls up
    EXISTING insight_checkpoints_v2 checkpoints across every survey sharing a
    tag (see docs/tag-report/DESIGN.md §2). The backend resolves
    ``effective_max_surveys`` (the 3-tier max-surveys-per-tag-report COALESCE)
    and hands off; this graph owns all checkpoint-level work — candidate
    fetching, checkpoint resolution, backfill looping, gating, merge, narrate,
    publish (docs/tag-report/TRACKER.md §2, reconciliation item 7).

    Body:
      run_id                 — UUID of the group_insight_runs row (created by backend before calling this)
      org_id                 — organisation UUID
      tag_id                 — UUID of the tag being rolled up
      run_mode                — 'manual' | 'automated' | 'custom_range'
      window_start/window_end — ISO8601, only meaningful for run_mode='custom_range'
      effective_max_surveys   — backend-resolved survey ceiling; used as target_n

    Returns:
      { run_id, status: "running" }
    """
    body = await request.json()
    run_id = body.get("run_id")
    org_id = body.get("org_id")
    tag_id = body.get("tag_id")
    run_mode = body.get("run_mode") or "manual"
    window_start = body.get("window_start")
    window_end = body.get("window_end")
    effective_max_surveys = body.get("effective_max_surveys")

    if not all([run_id, org_id, tag_id]):
        raise HTTPException(status_code=422, detail="run_id, org_id, and tag_id required")

    # Mark the run as running in DB
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """UPDATE group_insight_runs
                       SET status = 'running', heartbeat_at = NOW()
                       WHERE id = %s AND org_id = %s""",
                    (run_id, org_id),
                )
            await conn.commit()
    except Exception as exc:
        logger.warning("tag_report_run_status_update_failed", run_id=run_id, error=str(exc))

    from crystalos.graphs.tag_report import run_tag_report_generation

    # Fixed 2026-07-02 (integration reconciliation): this previously imported
    # TAG_REPORT_DEFAULT_TARGET_N from crystalos.lib.constants, which does not
    # exist there — Tag Report's tunables live as module-level constants inside
    # graphs/tag_report.py itself (kept out of the shared constants module by
    # design, see that file's own header). That import would have raised
    # AttributeError on the very first request with a falsy effective_max_surveys.
    # run_tag_report_generation already has its own correct fallback to
    # TAG_REPORT_DEFAULT_TARGET_N when target_n is None — just defer to it instead
    # of duplicating (and having gotten wrong) that fallback here.
    target_n = int(effective_max_surveys) if effective_max_surveys else None
    task = asyncio.create_task(
        run_tag_report_generation(
            run_id=run_id, org_id=org_id, tag_id=tag_id, report_mode=run_mode,
            window_start=window_start, window_end=window_end, target_n=target_n,
        )
    )
    task.add_done_callback(
        lambda t: logger.warning("tag_report_task_unhandled_error", run_id=run_id,
                                 error=str(t.exception()))
        if not t.cancelled() and t.exception() else None
    )

    logger.info("tag_report_generation_started", run_id=run_id, org_id=org_id,
                tag_id=tag_id, run_mode=run_mode)
    return {"run_id": run_id, "status": "running"}


# ── Sample response generation ────────────────────────────────────────────────────

@app.post("/responses/generate", summary="Generate synthetic sample responses for a survey")
async def generate_sample_responses(
    request: Request,
    _: None = Depends(require_internal_key),
) -> dict:
    """
    Generates realistic synthetic survey responses using the response_gen agent.

    Body:
      survey_id, org_id, survey_title, survey_intent, questions, count, persona_mix

    Returns:
      { responses: [{answers, nps_score, persona}], count: int }
    """
    from crystalos.agents.response_generator import ResponseGenInput, response_generator_agent

    body = await request.json()
    try:
        inp = ResponseGenInput(**body)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))

    if not inp.questions:
        raise HTTPException(status_code=422, detail="Survey has no questions")

    responses, _ = await response_generator_agent.run(inp)
    return {"responses": responses, "count": len(responses)}


# ── Prism: import-mapping skills (schema-mapper / taxonomy-mapper / metric-parity) ─
# The Node backend's Prism resolver calls these via agentsClient (X-Internal-Key).
# Each is org_id-scoped, structured-JSON (not SSE), and runs a single skill via the
# skill registry — mirroring the compliance-scanner dispatch in _dispatch_recommendation.
# CrystalOS PROPOSES; the backend persists on confirm. These never mutate state.

async def _run_prism_skill(skill_name: str, org_id: str, skill_input: dict) -> dict:
    """Run a single Prism skill via the skill registry and return its raw output dict.

    Mirrors the registry.execute() pattern used by check_compliance above:
    `result = await registry.execute(name, input_data, ctx)` → result["output"].
    Raises HTTPException on missing org_id / uninitialised registry / skill error.
    """
    if not org_id:
        raise HTTPException(status_code=400, detail="org_id required")

    from crystalos.lib.skill_registry import get_registry as _get_skill_reg
    reg = _get_skill_reg()
    if not reg.is_initialized() or reg.get_skill_meta(skill_name) is None:
        raise HTTPException(status_code=503, detail=f"Skill {skill_name!r} unavailable")

    try:
        # ctx carries org_id so the example-bank writer is org-scoped.
        result = await reg.execute(skill_name, skill_input, {"org_id": org_id})
    except Exception as exc:
        logger.warning("prism_skill_failed", skill=skill_name, org_id=org_id, error=str(exc))
        raise HTTPException(status_code=502, detail=f"{skill_name} failed: {str(exc)[:160]}")

    output = result.get("output") or {}
    if not output or ("error" in output and len(output) == 1):
        raise HTTPException(status_code=502, detail=f"{skill_name} returned no usable output")
    return output


@app.post("/prism/map", summary="Prism schema-mapper — propose field mappings for the residual")
async def prism_map(request: Request, _: None = Depends(require_internal_key)) -> dict:
    """Run the schema-mapper skill on the ambiguous residual fields.

    Body: { org_id, connection_id, platform, fields: [...], samples? }
    `fields` are the residual source fields the deterministic L1/L2 layers could not
    resolve; passed through as the skill's `source_fields`. Returns { mappings: [...] }.
    """
    body          = await request.json()
    org_id        = body.get("org_id", "")
    connection_id = body.get("connection_id", "")
    platform      = body.get("platform", "")
    fields        = body.get("fields") or []
    samples       = body.get("samples") or {}

    # Map the endpoint body → schema-mapper input schema (see skills/schema-mapper/SKILL.md).
    # TODO(verify): the resolver currently sends only {name, type}; richer fields
    # (label/sample_values/option_labels) flow through when the connector profile carries them.
    skill_input = {
        "source_platform": platform,
        "source_fields":   fields,
        "target_questions": body.get("target_questions") or [],
        "known_metrics":   body.get("known_metrics") or [],
        "samples":         samples,
    }
    output = await _run_prism_skill("schema-mapper", org_id, skill_input)
    logger.info("prism_map", org_id=org_id, connection_id=connection_id,
                field_count=len(fields), mapping_count=len(output.get("mappings") or []))
    return {"mappings": output.get("mappings") or [],
            "unmapped": output.get("unmapped") or [],
            "scale_changes": output.get("scale_changes") or [],
            "summary": output.get("summary", "")}


@app.post("/prism/taxonomy", summary="Prism taxonomy-mapper — reconcile imported topic labels")
async def prism_taxonomy(request: Request, _: None = Depends(require_internal_key)) -> dict:
    """Run the taxonomy-mapper skill to reconcile imported labels against the registry.

    Body: { org_id, survey_id, imported_labels: [...], existing_topics: [...] }
    Returns { resolutions: [...] } (+ conflicts / registry_additions).
    """
    body            = await request.json()
    org_id          = body.get("org_id", "")
    survey_id       = body.get("survey_id", "")
    imported_labels = body.get("imported_labels") or []
    existing_topics = body.get("existing_topics") or []

    # Map the endpoint body → taxonomy-mapper input schema (skills/taxonomy-mapper/SKILL.md).
    skill_input = {
        "source_platform": body.get("platform", ""),
        "imported_labels": imported_labels,
        "registry_topics": existing_topics,
    }
    output = await _run_prism_skill("taxonomy-mapper", org_id, skill_input)
    logger.info("prism_taxonomy", org_id=org_id, survey_id=survey_id,
                label_count=len(imported_labels),
                resolution_count=len(output.get("resolutions") or []))
    return {"resolutions": output.get("resolutions") or [],
            "conflicts": output.get("conflicts") or [],
            "registry_additions": output.get("registry_additions") or [],
            "summary": output.get("summary", "")}


@app.post("/prism/parity", summary="Prism metric-parity — explain a metric gap + recommend a method")
async def prism_parity(request: Request, _: None = Depends(require_internal_key)) -> dict:
    """Run the metric-parity skill to explain a source-vs-Prism metric delta.

    Body: { org_id, survey_id, metric, source_value, responses_summary }
    Returns { explanation, recommended_method, parity_ledger }.
    """
    body               = await request.json()
    org_id             = body.get("org_id", "")
    survey_id          = body.get("survey_id", "")
    metric             = body.get("metric", "")
    source_value       = body.get("source_value")
    responses_summary  = body.get("responses_summary") or {}

    # Map the endpoint body → metric-parity input schema (skills/metric-parity/SKILL.md).
    # `responses_summary` carries the response evidence + prism_computed + method context.
    skill_input = {
        "survey_id":         survey_id,
        "metric":            metric,
        "source_reported":   source_value,
        "prism_computed":    responses_summary.get("prism_computed"),
        "response_window":   responses_summary.get("response_window") or {},
        "method_context":    responses_summary.get("method_context") or {},
        "response_evidence": responses_summary.get("response_evidence") or responses_summary,
    }
    output = await _run_prism_skill("metric-parity", org_id, skill_input)
    logger.info("prism_parity", org_id=org_id, survey_id=survey_id, metric=metric)
    return {"explanation": output.get("explanation", ""),
            "hypothesis": output.get("hypothesis") or {},
            "recommended_method": output.get("recommended_method", "match_source"),
            "recommendation_rationale": output.get("recommendation_rationale", ""),
            "parity_ledger": output.get("parity_ledger") or {},
            "citations": output.get("citations") or []}


# ── Crystal: stateful conversational analyst ─────────────────────────────────────

@app.post("/insights/crystal", summary="Stateful Crystal AI analyst for the insights page")
async def crystal_chat(request: Request, _: None = Depends(require_internal_key)) -> dict:
    """Stateful Crystal AI analyst for the insights page."""
    from crystalos.agents.crystal import crystal_agent, CrystalInput
    from crystalos.lib.security import check_survey_access

    body = await request.json()
    try:
        inp = CrystalInput(**body)
    except Exception:
        raise HTTPException(status_code=422, detail="Invalid request body")

    if inp.survey_id:
        survey = await check_survey_access(inp.survey_id, inp.org_id)
        if survey is None:
            raise HTTPException(status_code=404, detail="Survey not found")

    output, _ = await crystal_agent.run(inp)
    return {
        "answer":       output.answer,
        "suggestions":  output.suggestions,
        "insight_refs": output.insight_refs,
        "citations":    output.citations,
    }


# ── Crystal Support endpoint ─────────────────────────────────────────────────

@app.post("/insights/crystal-support", summary="Crystal support assistant (crystal-support skill)")
async def crystal_support_endpoint(request: Request, _: None = Depends(require_internal_key)) -> dict:
    """Crystal support mode — classifies support intent, searches docs, escalates if needed."""
    from crystalos.lib.support_classifier import classify_support_intent
    from crystalos.crystal.context import CrystalContext
    from crystalos.crystal.tools import dispatch_tool

    body = await request.json()
    message: str = body.get("message", "").strip()
    if not message:
        raise HTTPException(status_code=422, detail="message required")

    org_id: str = body.get("org_id", "")
    user_id: str = body.get("user_id", "")
    context_data: dict = body.get("context", {})

    # Fast intent classification (no LLM)
    classification = await classify_support_intent(message)

    ctx = CrystalContext(
        org_id=org_id,
        user_id=user_id,
        survey_id=None,
    )

    # Pre-fetch tool results for common intents
    tool_results: dict = {}
    try:
        if classification.intent and classification.intent.value in ("bug_report", "account_issue"):
            tool_results["known_issues"] = await dispatch_tool("get_known_issues", ctx, {})
        if classification.intent and classification.intent.value in ("bug_report",):
            tool_results["system_status"] = await dispatch_tool("get_system_status", ctx, {})
        if message and len(message) > 3:
            tool_results["search_results"] = await dispatch_tool(
                "search_support_docs", ctx, {"query": message, "limit": 5}
            )
    except Exception as pre_exc:
        logger.warning("crystal_support_prefetch_failed", error=str(pre_exc))

    # Route to skill via skill registry
    skill_reg = None
    try:
        from crystalos.lib.skill_registry import get_registry as get_skill_registry
        skill_reg = get_skill_registry()
    except Exception:
        pass

    if skill_reg is not None:
        try:
            skill_input = {
                "message": message,
                "org_id": org_id,
                "user_id": user_id,
                "context": context_data,
                "tool_results": tool_results,
                "classification": {
                    "intent": classification.intent.value if classification.intent else None,
                    "confidence": classification.confidence,
                    "is_support": classification.is_support,
                },
            }
            result = await skill_reg.execute("crystal-support", skill_input)
            if result:
                return {
                    "answer": result.get("answer", ""),
                    "citations": result.get("citations", []),
                    "suggestions": result.get("suggestions", []),
                    "intent": result.get("intent", classification.intent.value if classification.intent else None),
                    "confidence": result.get("confidence", classification.confidence),
                    "resolved": result.get("resolved", False),
                    "escalation_package": result.get("escalation_package"),
                    "action_proposals": result.get("action_proposals", []),
                }
        except Exception as skill_exc:
            logger.warning("crystal_support_skill_failed", error=str(skill_exc))

    # Fallback: return search results directly
    search_docs = (tool_results.get("search_results") or {}).get("docs", [])
    answer = (
        f"I found {len(search_docs)} relevant article(s) for your question."
        if search_docs
        else "I couldn't find a specific article. Let me connect you with our support team."
    )
    return {
        "answer": answer,
        "citations": [d.get("key", "") for d in search_docs],
        "suggestions": ["Search for a different term", "Check known issues", "Create a support ticket"],
        "intent": classification.intent.value if classification.intent else "general",
        "confidence": classification.confidence,
        "resolved": len(search_docs) > 0,
        "escalation_package": None if search_docs else {
            "title": message[:100],
            "description": "Crystal could not find a resolution. Human review needed.",
            "severity": "medium",
        },
        "action_proposals": [],
    }


# ── Crystal: SSE streaming ReAct endpoint ────────────────────────────────────────

@app.post("/insights/crystal/stream", summary="SSE streaming Crystal skill-first analyst")
async def crystal_stream_endpoint(
    req: Request,
    _: None = Depends(require_internal_key),
    debug: bool = False,
    store_trace: bool = False,
    legacy: bool = False,
):
    """SSE streaming endpoint for Crystal.

    Default path: skill framework (_run_skill_stream) — deterministic tool calls +
    SkillRuntime synthesis. Fast, cheap, observable via the admin skill dashboard.

    Query params:
      debug=true   — emit routing + timing SSE debug events (admin/brand_admin only)
      legacy=true  — use the old LLM-driven ReAct tool-selection loop (admin only)
    """
    from crystalos.agents.crystal import CrystalInput, _run_skill_stream, _run_react_loop_streaming
    from crystalos.lib.security import check_survey_access
    from fastapi.responses import StreamingResponse

    body = await req.json()
    survey_id = body.get("survey_id", "")
    org_id    = body.get("org_id", "")

    # Gate debug/legacy mode to admin roles only.
    # user_role should ultimately come from backend JWT injection; until then,
    # validate against the whitelist to prevent arbitrary role escalation.
    raw_role = body.get("user_role", "viewer")
    VALID_ROLES = {"admin", "brand_admin", "analyst", "viewer"}
    user_role = raw_role if raw_role in VALID_ROLES else "viewer"
    if (debug or legacy) and user_role not in ("admin", "brand_admin"):
        debug = False
        store_trace = False
        legacy = False

    if survey_id:
        survey = await check_survey_access(survey_id, org_id)
        if survey is None:
            raise HTTPException(status_code=404, detail="Survey not found")

    inp = CrystalInput(
        survey_id=survey_id,
        org_id=org_id,
        message=body.get("message", ""),
        insights=body.get("insights", []),
        topics=body.get("topics", []),
        survey_title=body.get("survey_title", ""),
        survey_response_count=body.get("survey_response_count", 0),
        metrics=body.get("metrics", {}),
        conversation_history=body.get("conversation_history", []),
        user_id=body.get("user_id", ""),
        scope=body.get("scope", "survey"),
        has_open_text=body.get("has_open_text", True),
        tag_ids=body.get("tag_ids"),
        tag_id=body.get("tag_id"),
        user_role=user_role,
        brand_id=body.get("brand_id"),
        # Wave 15 — Automation Hub workflow-builder context (all optional;
        # absent for every existing caller -> CrystalInput defaults apply,
        # byte-identical to pre-Wave-15 behavior). `surface` forces routing to
        # workflow-analyst in _run_skill_stream when the frontend signals it
        # opened Crystal from the builder page (see docs/automation-hub/TRACKER.md).
        surface=body.get("surface", "insights"),
        builder_draft=body.get("builder_draft"),
        workflow_registry=body.get("workflow_registry"),
    )

    # Choose execution path
    stream_fn = (
        lambda: _run_react_loop_streaming(inp, request=req, debug=debug, store_trace=store_trace)
        if legacy
        else _run_skill_stream(inp, request=req, debug=debug)
    )

    async def event_stream():
        import json as _json
        answered = False
        try:
            async for event_json in stream_fn():
                answered = True
                yield f"data: {event_json}\n\n"
        except Exception as exc:
            if not answered:
                from crystalos.agents.crystal import _run_crystal
                try:
                    yield f"data: {_json.dumps({'type': 'synthesizing'})}\n\n"
                    final = await _run_crystal(inp)
                    yield f"data: {_json.dumps({'type': 'answer', 'answer': final.answer, 'citations': final.citations, 'suggestions': final.suggestions})}\n\n"
                except Exception:
                    yield f"data: {_json.dumps({'type': 'error', 'message': 'Crystal is unavailable right now. Please try again.'})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── Agent registry ───────────────────────────────────────────────────────────────

@app.get("/agents/registry", summary="List all agent manifests (active + stubs) plus CrystalOS skills")
async def list_agents(_key: None = Depends(require_internal_key)) -> dict:
    # Legacy agent manifests (BaseAgent subclasses)
    legacy_agents = [
        {
            "name":              a.manifest.name,
            "version":           a.manifest.version,
            "description":       a.manifest.description,
            "tags":              a.manifest.tags,
            "enabled":           a.manifest.enabled,
            "phase":             a.manifest.phase,
            "required_features": a.manifest.required_features,
            "est_cost_usd":      a.manifest.est_cost_usd,
            "type":              "legacy_agent",
        }
        for a in ALL_AGENTS
    ]
    # CrystalOS skill registry (SKILL.md-based)
    try:
        from crystalos.lib.skill_registry import get_registry as _get_skill_reg
        skill_entries = [
            {**s, "type": "crystalos_skill"}
            for s in _get_skill_reg().list_skills()
        ]
    except Exception:
        skill_entries = []

    return {
        "agents": legacy_agents,
        "skills": skill_entries,
        "total": len(legacy_agents) + len(skill_entries),
    }


# ── Internal: checkpoint blob proxy ─────────────────────────────────────────────
# Used by the Node.js backend to fetch checkpoint report blobs in dev/dev-paid.
# In staging/prod the backend receives a signed OCI PAR URL instead — this endpoint
# is only exercised when AGENTS_ENV is dev or dev-paid.

@app.get("/internal/checkpoint-blob", include_in_schema=False)
async def get_checkpoint_blob_internal(
    ref: str,
    _key: None = Depends(require_internal_key),
) -> dict:
    """
    Proxy a checkpoint blob by its storage ref.
    ref is an absolute local path (dev) or OCI object key (staging/prod).
    Returns the parsed + migrated JSON blob.
    """
    from crystalos.lib.checkpoint_store import read_checkpoint_blob, CHECKPOINT_LOCAL_PATH, is_local_ref
    from pathlib import Path

    # Validate local refs stay within the checkpoint directory (prevent path traversal).
    # Path.is_relative_to() does a proper path-component check (Python 3.9+); it is
    # immune to the sibling-directory bypass that str.startswith() is vulnerable to
    # (e.g. /checkpoints-evil would pass a str prefix check against /checkpoints).
    if is_local_ref(ref):
        base = Path(CHECKPOINT_LOCAL_PATH).resolve()
        target = (base / ref).resolve()
        if not target.is_relative_to(base):
            raise HTTPException(status_code=400, detail="Invalid checkpoint ref")

    try:
        return await read_checkpoint_blob(ref)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Checkpoint blob not found")
    except Exception as exc:
        logger.error("checkpoint_blob_fetch_failed", ref=ref, error=str(exc))
        raise HTTPException(status_code=500, detail="Failed to read checkpoint blob")


@app.get("/internal/checkpoint-read-url", include_in_schema=False)
async def get_checkpoint_read_url_internal(
    ref: str,
    expiry_minutes: int = 15,
    _key: None = Depends(require_internal_key),
) -> dict:
    """
    Return a readable URL for a checkpoint blob.
    dev/dev-paid: returns the ref unchanged (backend proxies the blob directly).
    staging/prod: returns a signed OCI PAR URL valid for expiry_minutes.
    """
    from crystalos.lib.checkpoint_store import get_checkpoint_read_url
    try:
        url = await get_checkpoint_read_url(ref, expiry_minutes)
        return {"url": url}
    except Exception as exc:
        logger.error("checkpoint_read_url_failed", ref=ref, error=str(exc))
        raise HTTPException(status_code=500, detail="Failed to generate checkpoint URL")


# ── Health + Metrics ─────────────────────────────────────────────────────────────

@app.get("/health", include_in_schema=False)
async def health() -> dict:
    return {"status": "ok", "service": "agents", "env": os.getenv("AGENTS_ENV", "dev")}


@app.get("/metrics", include_in_schema=False)
async def metrics() -> PlainTextResponse:
    return PlainTextResponse(generate_latest(metrics_registry), media_type=CONTENT_TYPE_LATEST)


# ── DLQ Admin ────────────────────────────────────────────────────────────────────

@app.get("/api/admin/crystal/dlq", summary="List DLQ trigger-failure entries")
async def list_dlq_entries(_key: None = Depends(require_internal_key)) -> dict:
    from crystalos.consumers.response_stream import _get_redis, DLQ_KEY
    redis = await _get_redis()
    if redis is None:
        return {"entries": [], "count": 0, "error": "Redis unavailable"}
    try:
        raw = await redis.lrange(DLQ_KEY, 0, -1)
        entries = [json.loads(e) for e in raw]
        return {"entries": entries, "count": len(entries)}
    except Exception as exc:
        logger.warning("dlq_list_failed", error=str(exc))
        return {"entries": [], "count": 0, "error": str(exc)}


@app.post("/api/admin/crystal/dlq/replay", summary="Replay all DLQ entries")
async def replay_dlq(_key: None = Depends(require_internal_key)) -> dict:
    from crystalos.consumers.response_stream import _get_redis, DLQ_KEY, _trigger_insights
    redis = await _get_redis()
    if redis is None:
        raise HTTPException(status_code=503, detail="Redis unavailable")
    try:
        raw = await redis.lrange(DLQ_KEY, 0, -1)
        if not raw:
            return {"replayed": 0, "message": "DLQ is empty"}
        await redis.delete(DLQ_KEY)
        replayed = 0
        for item in raw:
            entry = json.loads(item)
            try:
                await _trigger_insights(entry["survey_id"], entry["org_id"])
                replayed += 1
            except Exception as exc:
                logger.warning("dlq_replay_item_failed", entry=entry, error=str(exc))
                await redis.rpush(DLQ_KEY, item)
        return {"replayed": replayed, "total": len(raw)}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("dlq_replay_failed", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc))


# ── Dev entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "agents.main:app",
        host=os.getenv("AGENTS_HOST", "0.0.0.0"),
        port=int(os.getenv("AGENTS_PORT", "8001")),
        reload=os.getenv("AGENTS_ENV", "dev") == "dev",
        log_level="info",
        loop="asyncio",   # uvloop has a signal-handling bug with Python 3.14
    )
