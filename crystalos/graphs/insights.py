"""Insight Generation DAG — LangGraph state machine.

Pipeline:
  ingest → embed → [metrics + extract_texts (parallel)] → absa → cluster
         → topics → narrate → verify → publish

Key capabilities added in this version:
- Real OpenAI embeddings (with BoW heuristic fallback) for cosine clustering
- node_embed: embeds all open texts before clustering
- node_topics: LLM-based canonical topic discovery with new-topic detection
- Effort score per topic
- CSAT narrated via LLM (not hardcoded)
- L3 Predictive trend insights (volume up/down + NPS trajectory)
- Smart prescriptive actions (not always "create ticket")
- Time-windowed per-window metric insights in publish
- Dynamic trust scores (sample-size, coverage, consistency, grounding)
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
import traceback
from typing import Any, Literal, TypedDict

import structlog
from langgraph.graph import StateGraph, END

from crystalos.lib import db
from crystalos.lib.constants import (
    WINDOW_MIN_RESPONSES, TOPIC_ASSIGNMENT_THRESHOLD,
    INGEST_MAX_RESPONSES_BOOTSTRAP, INGEST_MAX_RESPONSES_CAP,
    INGEST_NEW_RESPONSE_ABSA_CAP, INGEST_ANCHOR_RESPONSES,
    INGEST_LARGE_SURVEY_THRESHOLD, compute_stratified_buckets,
    NARRATE_MAX_ATTEMPTS, REPORT_QUALITY_RENARRATE_THRESHOLD,
    PRIOR_INSIGHT_MIN_TRUST, PRIOR_INSIGHT_MAX_COUNT, PRIOR_INSIGHT_LAYERS,
    USE_SKILL_RUNTIME,
    PROGRESSIVE_TIER_FIRST_VOICES, PROGRESSIVE_TIER_EARLY_SIGNALS,
    PROGRESSIVE_TIER_GROWING_PICTURE, PROGRESSIVE_TIER_FULL_REPORT,
    STOP_LEGACY_CHECKPOINT_WRITE, DEFAULT_STREAM_THRESHOLD,
)
from crystalos.lib.logger import logger
from crystalos.lib.openrouter import call_agent
from crystalos.schemas.insight import (
    InsightStateModel, InsightRecord, TrustComponents, AuditInfo,
    NarrateInsightOutput, VerifyInsightOutput,
)
from crystalos.tools.metrics import (
    compute_nps_ci, compute_csat, compute_ces,
    compute_completion_rate, compute_response_trend, extract_open_texts,
    compute_effort_score, compute_response_trend_analysis, filter_responses_by_window,
)
from crystalos.tools.clustering import cluster_texts
from crystalos.tools.sentiment import run_absa_llm, detect_dominant_emotion, score_sentiment, _score_to_sentiment
from crystalos.tools.embeddings import get_or_create_embeddings
from crystalos.tools.topics import (
    discover_topics, upsert_survey_topics, get_previous_topic_names,
    build_topic_hierarchy,
)
from crystalos.lib.topic_signals import compute_full_topic_signals
from crystalos.lib import topic_registry
from crystalos.agents.insight_experts import (
    narrate_nps_insight, narrate_csat_insight,
    narrate_topic_insight, narrate_trend_insight,
    narrate_prescriptive_insight, evaluate_insight_set,
    NpsExpertOutput, CsatExpertOutput, TopicExpertOutput,
    TrendExpertOutput, PrescriptiveExpertOutput,
)
from crystalos.graphs.nodes.context import node_context, node_route_specialists
from crystalos.agents.tiered_report import run_tiered_report_agent
from crystalos.specialists.registry import get_registry
from crystalos.schemas.context import OrgContextModel, SurveyContextModel
from crystalos.lib.checkpoint_store import write_checkpoint_blob
from crystalos.lib.constants import (
    CHECKPOINT_BLOB_SCHEMA_VERSION,
    INSIGHT_CHECKPOINTS_V2_ENABLED,
    INSIGHT_PROFILE_AUTOMATED, INSIGHT_PROFILE_REFRESH,
    INSIGHT_PROFILE_MANUAL_EXPERT, INSIGHT_PROFILE_MANUAL_QUICK,
)


# ── Signal extraction helpers ─────────────────────────────────────────────────

def extract_signals_from_response(answers: list, questions: list) -> dict:
    """Map each answer to its signal type based on question type."""
    signals: dict = {}
    q_map = {q.get("id"): q for q in questions}
    for answer in answers:
        qid = answer.get("questionId") or answer.get("question_id")
        q = q_map.get(qid) if qid else None
        qtype = q.get("type") if q else None
        val = answer.get("value")
        if qtype == "nps":
            try: signals["nps_score"] = int(val)
            except (TypeError, ValueError): pass
        elif qtype == "csat":
            try: signals["csat_score"] = float(val)
            except (TypeError, ValueError): pass
        elif qtype == "ces":
            try: signals["ces_score"] = float(val)
            except (TypeError, ValueError): pass
        elif qtype == "rating":
            try: signals["rating_value"] = float(val)
            except (TypeError, ValueError): pass
        elif qtype in ("open_text", "short_text", "text", "textarea"):
            if val and str(val).strip():
                signals.setdefault("open_text", []).append(str(val).strip())
        elif qtype == "boolean":
            signals["boolean_value"] = bool(val)
        elif qtype == "multiple_choice":
            signals["selected_option"] = val
        elif qtype == "ranking":
            signals["rank_order"] = val
    return signals


def compute_survey_capability_flags(questions: list) -> dict:
    """Return capability booleans based on question types present."""
    types = {q.get("type") for q in questions}
    return {
        "has_nps":       "nps" in types,
        "has_csat":      "csat" in types,
        "has_ces":       "ces" in types,
        "has_open_text": bool(types & {"open_text", "short_text", "text", "textarea"}),
        "has_ratings":   "rating" in types,
    }


# ── State type ───────────────────────────────────────────────────────────────

class InsightState(TypedDict, total=False):
    survey_id:            str
    org_id:               str
    run_id:               str
    trigger:              str
    force_regenerate:     bool
    is_bootstrap:         bool                    # True on first run (no centroids yet)
    bootstrap_centroids:  list[list[float] | None] # centroid per cluster index, bootstrap only
    survey:               dict[str, Any]
    responses:            list[dict[str, Any]]
    new_response_ids:     set[str]
    metrics:              dict[str, Any]
    open_texts:           list[dict[str, Any]]
    embedded_texts:       list[dict[str, Any]]
    absa_results:         list[dict[str, Any]]
    clusters:             list[dict[str, Any]]
    topics:               list[Any]
    topic_signals:        dict[str, Any]          # name → full_topic_signals dict from node_topics
    drivers:              list[Any]
    stream_events:        list[Any]
    insights:             list[dict[str, Any]]
    insights_from_cache:  bool
    narrate_attempt:      int                     # re-narration loop counter (capped at NARRATE_MAX_ATTEMPTS)
    errors:               list[str]
    org_context:          dict[str, Any]
    survey_context:       dict[str, Any]
    selected_specialists: list[str]
    has_open_text:        bool
    has_nps:              bool
    has_csat:             bool
    has_ces:              bool
    survey_questions:     list[dict[str, Any]]
    prior_snapshots:      list[dict[str, Any]]    # recent survey_metric_snapshots for longitudinal context
    last_report_response_count: int               # response count when last report.* insights were generated
    prior_insights:       list[dict[str, Any]]    # high-confidence insights from last run — used for incremental narration and delta report
    prior_context_run_id: str                     # run_id of the anchor run whose insights were used as prior context
    # ── Insight Pipeline v2 — Phase 0.5 (node_delta_compute) ──────────────────
    delta_from_prior:     dict[str, Any] | None   # compute_delta() output, or None on bootstrap / load failure
    meaningful_delta:     bool                     # True = write checkpoint (always True on bootstrap)
    prior_checkpoint_summaries: list[dict[str, Any]]  # [{checkpoint_number, created_at, nps}], oldest first
    # Insight Pipeline v2 — Phase 2/3 (resolve_context + profiles)
    profile:              str                      # automated_incremental | refresh | manual_expert | manual_quick
    actor:                str                      # system:stream | system:scheduler | user:{id}
    survey_settings:      dict[str, Any]           # effective settings (3-level COALESCE merge)
    parent_checkpoint:    dict[str, Any] | None    # latest automated checkpoint row (v2 or legacy)
    prior_checkpoints:    list[dict[str, Any]]     # walked parent chain (full rows / blobs)
    watermark:            Any                      # parent.response_high_watermark (datetime) or None
    window_start:         Any                      # manual/refresh window lower bound (datetime) or None
    window_end:           Any                      # manual/refresh window upper bound (datetime) or None
    metric_snapshots:     list[dict[str, Any]]     # snapshots loaded per profile rules
    config_hash:          str                      # sha256(canonical settings) for lineage
    sample_ids:           set[str]                 # manual/refresh sampled response ids
    sample_stats:         dict[str, Any]           # {corpus_size, sampled, window_start, window_end}
    parent_checkpoint_id: str                      # explicit override / resolved parent id (v2)
    config_override:      dict[str, Any]           # caller config override merged into settings
    skip_run:             bool                     # resolve_context decided to abort
    skip_reason:          str                      # reason string for skip_run
    skip_report:          bool                     # automated_report_generation_enabled=False routing
    report_id:            str                      # insight_reports row id (manual modes)


# ── Model config ──────────────────────────────────────────────────────────────

INSIGHT_TEMPERATURE = 0.0
DEFAULT_SEED = 42

# Time windows for per-window metric publishing
WINDOWS = ["all_time", "last_30d", "last_7d"]


class _ManualSampleLoaded(Exception):
    """Control-flow sentinel: resolve_context already produced the manual/refresh
    sample, so node_ingest skips its stratified-sampling block (raised + caught
    inside node_ingest only — never propagates)."""

# Tier-milestone response counts (Insight Pipeline v2 §9 decision table). A run whose
# total response count lands on one of these always writes a checkpoint, even when the
# metric/topic delta is below the meaningful threshold.
_TIER_MILESTONE_COUNTS: frozenset[int] = frozenset({
    PROGRESSIVE_TIER_FIRST_VOICES,     # 10
    PROGRESSIVE_TIER_EARLY_SIGNALS,    # 40
    PROGRESSIVE_TIER_GROWING_PICTURE,  # 70
    PROGRESSIVE_TIER_FULL_REPORT,      # 100
})


# ── Trust score helpers ───────────────────────────────────────────────────────

def _trust_statistical(n: int) -> int:
    """Convert sample size to statistical trust score (0–100)."""
    if n >= 100:
        return 90
    if n >= 50:
        return 80
    if n >= 30:
        return 70
    # Linear scale from 0 to 30 responses: 0→10, 30→70
    return max(10, round(10 + (n / 30.0) * 60))


def _build_metric_trust(n: int, below_minimum: bool = False) -> tuple[int, dict]:
    """Trust score for metric.* insights (NPS, CSAT, CES).

    Metric insights are computed facts derived from survey maths, not text-derived
    qualitative claims. Citation coverage and LLM grounding are irrelevant — their
    reliability comes entirely from sample size and CI width.

    Formula: purely statistical, with a small CI-width deduction for very small n.
    """
    stat = _trust_statistical(n)
    # Penalty for genuinely tiny samples: ≥30 → no penalty; <10 → –20
    ci_penalty = 0 if n >= 30 else (20 if n < 10 else round((30 - n) / 20 * 20))
    score = max(10, stat - ci_penalty)
    if below_minimum:
        score = min(score, 55)
    return score, {
        "statistical":          stat,
        "coverage":             100,   # metric facts don't require citations
        "consistency":          100,   # calculated from raw data, not text clusters
        "grounding":            100,   # sourced from survey responses directly
        "sample_size":          n,
        "below_minimum_sample": below_minimum,
    }


def _trust_coverage(mentions: int, total: int) -> int:
    """Fraction of responses contributing to this insight (0–100)."""
    if total == 0:
        return 50
    frac = mentions / total
    return max(20, min(100, round(frac * 100 + 30)))


def _trust_consistency(cluster: dict) -> int:
    """Higher if cluster sentiment is uniform, lower if mixed."""
    items = cluster.get("texts", [])
    if not items:
        return 70
    sentiments = [t.get("sentiment", "neutral") for t in items]
    dominant = cluster.get("dominant_sentiment", "neutral")
    dom_count = sum(1 for s in sentiments if s == dominant)
    frac = dom_count / len(sentiments)
    # 0.5 uniform → 60, 1.0 uniform → 95
    return max(50, min(95, round(50 + frac * 45)))


def _trust_grounding(verifier_pass: bool) -> int:
    return 100 if verifier_pass else 60


def _build_trust(
    n: int,
    mentions: int,
    total: int,
    cluster: dict | None = None,
    verifier_pass: bool = True,
    below_minimum: bool = False,
) -> tuple[int, dict]:
    """Compute dynamic trust score and trust_json dict."""
    statistical  = _trust_statistical(n)
    coverage     = _trust_coverage(mentions, total)
    consistency  = _trust_consistency(cluster) if cluster else 80
    grounding    = _trust_grounding(verifier_pass)
    overall = round((statistical * 0.35 + coverage * 0.25 + consistency * 0.25 + grounding * 0.15))
    return overall, {
        "statistical":           statistical,
        "coverage":              coverage,
        "consistency":           consistency,
        "grounding":             grounding,
        "sample_size":           n,
        "below_minimum_sample":  below_minimum,
        "verifier_pass":         verifier_pass,
    }


# ── Prescriptive action mapping ───────────────────────────────────────────────

def _prescriptive_action(cluster: dict | None, nps: float | None, csat: float | None) -> dict:
    """Map insight context to the most appropriate recommended action."""
    if cluster:
        aspect = cluster.get("aspect", "unknown")
        size   = cluster.get("size", 0)
        if size > 10:
            return {"type": "create_workflow", "label": "Automate follow-up", "target": aspect}
        return {"type": "investigate", "label": "Deep-dive analysis needed", "target": aspect}
    if nps is not None and nps < 30:
        return {"type": "alert", "label": "Flag for leadership review", "target": "nps"}
    if csat is not None and csat < 3:
        return {"type": "survey_followup", "label": "Send recovery survey", "target": "csat"}
    return {"type": "investigate", "label": "Deep-dive analysis needed", "target": "general"}


# ── Friction type inference ───────────────────────────────────────────────────

_FRICTION_KEYWORDS: list[tuple[str, list[str]]] = [
    ("price",   ["price", "pricing", "cost", "billing", "fee", "charge", "expensive", "value", "subscription", "refund"]),
    ("people",  ["support", "agent", "staff", "team", "representative", "empathy", "helpful", "rude", "service", "agent"]),
    ("process", ["wait", "slow", "delay", "onboarding", "setup", "checkout", "escalat", "steps", "process", "workflow", "time"]),
    ("policy",  ["policy", "return", "rule", "exception", "rigid", "strict", "cannot", "not allowed", "restriction"]),
]

def _infer_friction_type(aspect: str) -> str:
    """Heuristic: map topic name/aspect to CX friction taxonomy."""
    a = aspect.lower()
    for friction, keywords in _FRICTION_KEYWORDS:
        if any(k in a for k in keywords):
            return friction
    return "product"


# ── LLM helpers (model-router aware) ─────────────────────────────────────────

async def _narrate(system: str, user: str) -> NarrateInsightOutput:
    """Call the narrate agent via the model router (Claude Haiku in staging/prod)."""
    output, _ = await call_agent(
        agent_name="insight_narrate",
        system=system,
        user=user,
        output_schema=NarrateInsightOutput,
    )
    return output


async def _verify(claim: str, context: str) -> VerifyInsightOutput:
    """Call the verify agent to check if a claim is supported by context."""
    output, _ = await call_agent(
        agent_name="insight_verify",
        system=(
            "You are a fact-checker for survey insight claims. "
            "Determine whether the claim is directly supported by the provided response excerpts.\n\n"
            "You MUST respond with a JSON object containing exactly these two fields:\n"
            '  "supported": true or false  (boolean — is the claim backed by the excerpts?)\n'
            '  "reason": "one sentence explanation"\n\n'
            "Example: {\"supported\": true, \"reason\": \"Three excerpts directly mention this issue.\"}"
        ),
        user=f"Claim: {claim}\n\nResponse excerpts:\n{context}",
        output_schema=VerifyInsightOutput,
    )
    return output


async def _llm_raw(prompt: str, system: str = "", max_tokens: int = 1000) -> str:
    """Raw OpenRouter call for ABSA (free-form text, not structured output).

    Intentionally uses _retry_loop (NOT _call_with_backoff) so ABSA batch
    failures do not increment the shared circuit breaker counter. ABSA already
    falls back to heuristics on failure — cascading to trip the circuit would
    break narrate/verify/evaluate for the whole pipeline.
    """
    from crystalos.lib.openrouter import _retry_loop
    from crystalos.lib.models import ModelConfig, get_model

    base = get_model("insight_narrate")
    config = ModelConfig(
        model=base.model,
        max_tokens=max_tokens,
        temperature=INSIGHT_TEMPERATURE,
        use_anthropic_sdk=base.use_anthropic_sdk,
    )
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    # json_mode=False: ABSA prompts request a top-level JSON array; json_object
    # mode forces models (gpt-4o-mini etc.) to wrap it in a dict like
    # {"results": [...]}, which breaks _parse_absa_batch.
    content, _usage = await _retry_loop(messages, config, json_mode=False)
    return content


# ── Stream event helper ───────────────────────────────────────────────────────

async def _emit_event(run_id: str, event_type: str, agent: str, data: dict) -> None:
    try:
        event = {
            "event": event_type,
            "agent": agent,
            "data": data,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        async with db._pool_conn().connection() as conn:
            await conn.execute(
                """UPDATE agent_runs
                   SET stream_events = stream_events || %s::jsonb
                   WHERE id = %s""",
                (json.dumps([event]), run_id),
            )
    except Exception as exc:
        logger.warning("emit_event_failed", run_id=run_id, error=str(exc))


# ── Heartbeat helper ──────────────────────────────────────────────────────────

async def _update_heartbeat(run_id: str) -> None:
    """Update last_heartbeat_at for the running agent_run."""
    try:
        async with db._pool_conn().connection() as conn:
            await conn.execute(
                "UPDATE agent_runs SET last_heartbeat_at = NOW() WHERE id = %s",
                (run_id,),
            )
    except Exception as exc:
        logger.debug("heartbeat_update_failed", run_id=run_id, error=str(exc))


async def _call_specialist(
    reg,
    skill_name: str,
    skill_input: dict,
    ctx: dict,
) -> dict | None:
    """Call one specialist skill. Returns {specialist, actions} or None on any error."""
    try:
        if not reg.get_skill_meta(skill_name):
            return None
        result = await reg.execute(skill_name, skill_input, ctx)
        output = result.get("output", {})
        if output.get("actions"):
            return {"specialist": skill_name, "actions": output["actions"]}
    except Exception as exc:
        logger.debug("specialist_call_failed", skill=skill_name, error=str(exc))
    return None


async def _generate_action_recommendations(state: dict) -> None:
    """Run XM specialist skills in parallel then orchestrate into a unified action plan.

    Architecture:
      1. Build per-specialist inputs from pipeline state
      2. Determine which specialists are relevant (metric availability + survey type)
      3. Call all relevant specialists concurrently via asyncio.gather
      4. Pass specialist outputs to the action-recommender orchestrator
      5. Persist the final prioritized action plan

    Non-blocking async task started by asyncio.create_task() in node_publish.
    All failures are caught — never raises out of the task.
    """
    survey_id  = state["survey_id"]
    org_id     = state["org_id"]
    metrics    = state.get("metrics", {})
    topics     = state.get("topics", [])
    insights   = state.get("insights", [])
    total_resp = int(metrics.get("total_responses", 0))

    try:
        from crystalos.lib.skill_registry import get_registry as _get_reg
        reg = _get_reg()
        if not reg.is_initialized():
            logger.debug("skill_registry_not_initialized_for_actions")
            return

        # ── Shared context ─────────────────────────────────────────────────────
        survey_type = state.get("survey_type", "custom") or "custom"
        try:
            async with db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "SELECT questions FROM surveys WHERE id = %s AND org_id = %s AND deleted_at IS NULL",
                        (survey_id, org_id),
                    )
                    row = await cur.fetchone()
                    _questions_raw: list[dict] = []
                    if row and row[0]:
                        _questions_raw = row[0] if isinstance(row[0], list) else json.loads(row[0] or "[]")
        except Exception:
            _questions_raw = []

        nps_data   = metrics.get("nps",  {})
        csat_data  = metrics.get("csat", {})
        ces_data   = metrics.get("ces",  {})
        nps_score  = nps_data.get("score")
        csat_score = csat_data.get("score")
        ces_score  = ces_data.get("score")
        org_ctx    = {"industry": None, "company_size": None, "audience": "customers"}
        skill_ctx  = {"org_id": org_id, "survey_id": survey_id}

        top_themes_base = [
            {
                "label":           t.get("name", ""),
                "sentiment_score": float(t.get("sentiment_score", 0.0)),
                "volume_pct":      (t.get("volume") or 0) / max(1, total_resp),
                "urgency_score":   float(t.get("urgency_score", 0.5)),
                "trending":        t.get("trending"),
                "sample_verbatims": t.get("sample_verbatims", [])[:3],
            }
            for t in topics[:8]
        ]
        neg_themes = [t for t in top_themes_base if t["sentiment_score"] < -0.2]
        pos_themes = [t for t in top_themes_base if t["sentiment_score"] >= 0.3]

        # ── Build specialist call list ─────────────────────────────────────────
        specialist_calls: list[tuple[str, dict]] = []

        if nps_score is not None:
            specialist_calls.append(("nps-action-advisor", {
                "nps_score":           int(nps_score), "promoters_pct": float(nps_data.get("promoters", 0)),
                "passives_pct":        float(nps_data.get("passives", 0)),
                "detractors_pct":      float(nps_data.get("detractors", 0)),
                "response_count":      total_resp,
                "top_negative_themes": neg_themes[:5], "top_positive_themes": pos_themes[:3],
                "trend": None, "industry_benchmark": None, "survey_id": survey_id,
            }))

        if ces_score is not None:
            specialist_calls.append(("ces-action-advisor", {
                "ces_score": float(ces_score), "response_count": total_resp,
                "friction_themes": neg_themes[:5], "primary_friction_type": None,
                "first_contact_resolution_rate": None, "survey_id": survey_id,
            }))

        if csat_score is not None:
            specialist_calls.append(("csat-action-advisor", {
                "csat_score": float(csat_score), "top_box_pct": 0.0,
                "response_count": total_resp, "touchpoint": None,
                "top_dissatisfiers": [{"issue": t["label"], "volume_pct": t["volume_pct"], "sentiment_score": t["sentiment_score"], "verbatims": t["sample_verbatims"]} for t in neg_themes[:5]],
                "top_satisfiers": [{"driver": t["label"], "volume_pct": t["volume_pct"]} for t in pos_themes[:3]],
                "trend": None, "survey_id": survey_id,
            }))

        if survey_type and "enps" in survey_type.lower():
            specialist_calls.append(("enps-action-advisor", {
                "enps_score": nps_score or 0, "promoters_pct": float(nps_data.get("promoters", 0)),
                "passives_pct": float(nps_data.get("passives", 0)), "detractors_pct": float(nps_data.get("detractors", 0)),
                "response_count": total_resp, "top_engagement_themes": top_themes_base[:6],
                "retention_risk_signals": [], "company_size": None, "industry": None, "survey_id": survey_id,
            }))

        # Close-the-loop — only when there are distress signals
        alert_signals = []
        if nps_score is not None and nps_score < 7:
            alert_signals.append({"type": "low_score", "severity": "critical" if nps_score < 4 else "high", "description": f"NPS = {nps_score}", "sample_verbatim": None})
        if ces_score is not None and ces_score > 5.0:
            alert_signals.append({"type": "low_score", "severity": "high", "description": f"CES = {ces_score} (high effort)", "sample_verbatim": None})
        if csat_score is not None and csat_score < 3.5:
            alert_signals.append({"type": "low_score", "severity": "high", "description": f"CSAT = {csat_score}", "sample_verbatim": None})
        if alert_signals:
            specialist_calls.append(("close-the-loop-advisor", {
                "survey_id": survey_id, "alert_signals": alert_signals,
                "survey_type": survey_type, "org_context": org_ctx, "response_count": total_resp,
                "metrics": {"nps": {"score": nps_score}, "csat": {"score": csat_score}, "ces": {"score": ces_score}},
            }))

        # Survey improvement — always
        specialist_calls.append(("survey-improvement-advisor", {
            "survey_id": survey_id, "questions": _questions_raw[:15],
            "response_count": total_resp, "response_rate": None,
            "top_themes": top_themes_base[:5], "uncovered_areas": [], "survey_type": survey_type,
        }))

        # Distribution — always
        specialist_calls.append(("distribution-strategist", {
            "survey_id": survey_id, "response_count": total_resp, "response_rate": None,
            "current_channels": ["email"], "audience_type": "B2B customers",
            "industry": None, "survey_type": survey_type,
            "distribution_gaps": [], "non_respondent_estimate": None,
        }))

        # Predictive — when enough data
        if total_resp > 30:
            specialist_calls.append(("predictive-action-advisor", {
                "survey_id": survey_id,
                "current_metrics": {"nps": nps_score, "csat": csat_score, "ces": ces_score},
                "prior_metrics": {"nps": None, "csat": None, "ces": None},
                "trending_themes": [{"label": t["label"], "sentiment_delta": t["sentiment_score"], "volume_delta_pct": 0.0, "trending": t.get("trending", "stable") or "stable"} for t in top_themes_base[:5]],
                "anomaly_events": [], "response_rate_trend": None, "survey_type": survey_type,
            }))

        # Benchmark + Journey — always
        specialist_calls.extend([
            ("benchmark-strategist", {"survey_id": survey_id, "survey_type": survey_type,
                "metrics": {"nps": nps_score, "csat": csat_score, "ces": ces_score},
                "industry": None, "company_size": None, "trend": None}),
            ("journey-advisor", {"survey_id": survey_id, "survey_type": survey_type,
                "top_themes": top_themes_base[:6], "touchpoint": None, "org_context": org_ctx}),
        ])

        # ── Run all specialists in parallel ────────────────────────────────────
        tasks = [_call_specialist(reg, name, inp, skill_ctx) for name, inp in specialist_calls]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        valid_outputs = [r for r in results if r and isinstance(r, dict) and r.get("actions")]

        if not valid_outputs:
            logger.debug("no_specialist_outputs", survey_id=survey_id)
            return

        logger.info(
            "specialists_completed",
            survey_id=survey_id,
            total_specialists=len(specialist_calls),
            succeeded=len(valid_outputs),
            specialists=[r["specialist"] for r in valid_outputs],
        )

        # ── Orchestrate ────────────────────────────────────────────────────────
        if not reg.get_skill_meta("action-recommender"):
            logger.debug("action_recommender_orchestrator_not_found")
            return

        orch_input = {
            "specialist_outputs": valid_outputs,
            "survey_context": {
                "survey_type": survey_type,
                "metrics": {"nps": nps_score, "csat": csat_score, "ces": ces_score},
                "response_count": total_resp,
                "top_themes": [{"label": t["label"], "urgency_score": t["urgency_score"]} for t in top_themes_base[:5]],
            },
        }
        orch_result = await reg.execute("action-recommender", orch_input, skill_ctx)
        output  = orch_result.get("output", {})
        actions = output.get("actions", [])
        if not actions:
            logger.debug("orchestrator_returned_no_actions", survey_id=survey_id)
            return

        # ── Persist ────────────────────────────────────────────────────────────
        try:
            async with db._pool_conn().connection() as conn:
                await conn.execute(
                    """INSERT INTO action_recommendations
                       (survey_id, org_id, actions_json, urgency_level, summary, generated_at)
                       VALUES (%s, %s, %s, %s, %s, NOW())
                       ON CONFLICT (survey_id, org_id)
                       DO UPDATE SET actions_json = EXCLUDED.actions_json,
                                     urgency_level = EXCLUDED.urgency_level,
                                     summary = EXCLUDED.summary,
                                     generated_at = NOW()""",
                    (survey_id, org_id, json.dumps(actions),
                     output.get("urgency_level", "this_month"), output.get("summary", "")),
                )
            logger.info("action_recommendations_generated", survey_id=survey_id,
                        action_count=len(actions), specialists=len(valid_outputs))
        except Exception as db_exc:
            logger.debug("action_recommendations_db_failed", error=str(db_exc))

    except Exception as exc:
        logger.warning("action_recommendations_failed", survey_id=survey_id, error=str(exc))


# ── Node: resolve_context (Insight Pipeline v2 — Phase 2) ─────────────────────

_MANUAL_PROFILES: frozenset[str] = frozenset({
    INSIGHT_PROFILE_MANUAL_EXPERT, INSIGHT_PROFILE_MANUAL_QUICK,
})


def _config_hash(settings: dict) -> str:
    """sha256 of canonical-JSON settings — stored on each checkpoint for audit (03 §2)."""
    try:
        canonical = json.dumps(settings or {}, sort_keys=True, default=str)
    except Exception:
        canonical = str(settings)
    return hashlib.sha256(canonical.encode()).hexdigest()[:32]


async def walk_parent_chain(
    survey_id: str,
    org_id: str,
    lookback: int,
    max_age_days: int | None = None,
) -> list[dict]:
    """Walk the automated checkpoint chain newest→oldest, up to ``lookback`` nodes.

    Reads ``insight_checkpoints_v2`` (lane='automated') following ``parent_checkpoint_id``
    when available. Falls back to ``survey_insight_checkpoints`` ordered by
    ``checkpoint_number DESC`` when v2 is empty / absent. Rows older than
    ``max_age_days`` (when set) are excluded. Never raises — returns [] on any failure.

    Returns rows newest-first (the head is index 0). Each row is a plain dict of the
    columns present in whichever table was used.
    """
    if lookback <= 0:
        return []
    rows: list[dict] = []
    # ── Try v2 (linked list) first ────────────────────────────────────────────
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT * FROM insight_checkpoints_v2
                       WHERE survey_id = %s AND org_id = %s AND lane = 'automated'
                       ORDER BY checkpoint_number DESC
                       LIMIT %s""",
                    (survey_id, org_id, lookback),
                )
                fetched = await cur.fetchall()
                if fetched:
                    cols = [d[0] for d in cur.description]
                    rows = [dict(zip(cols, r)) for r in fetched]
    except Exception as exc:
        logger.debug("walk_parent_chain_v2_unavailable", survey_id=survey_id, error=str(exc))
        rows = []

    # ── Fallback: legacy survey_insight_checkpoints ───────────────────────────
    if not rows:
        try:
            async with db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """SELECT * FROM survey_insight_checkpoints
                           WHERE survey_id = %s AND org_id = %s
                           ORDER BY checkpoint_number DESC
                           LIMIT %s""",
                        (survey_id, org_id, lookback),
                    )
                    fetched = await cur.fetchall()
                    if fetched:
                        cols = [d[0] for d in cur.description]
                        rows = [dict(zip(cols, r)) for r in fetched]
        except Exception as exc:
            logger.warning("walk_parent_chain_legacy_failed", survey_id=survey_id, error=str(exc))
            return []

    # ── Age filter ────────────────────────────────────────────────────────────
    if max_age_days is not None and rows:
        from datetime import datetime as _dt, timezone as _tz, timedelta as _td
        cutoff = _dt.now(_tz.utc) - _td(days=max_age_days)
        kept = []
        for r in rows:
            created = r.get("created_at")
            if created is None:
                kept.append(r)
                continue
            try:
                if hasattr(created, "tzinfo"):
                    cdt = created if created.tzinfo else created.replace(tzinfo=_tz.utc)
                    if cdt >= cutoff:
                        kept.append(r)
                else:
                    kept.append(r)
            except Exception:
                kept.append(r)
        rows = kept
    return rows


async def node_resolve_context(state: dict) -> dict:
    """Resolve run context: settings, parent chain, watermark, window, snapshots.

    First node in the v2 graph (entry point). Implements 04 §2 + 02 §8 across all
    profiles. Never crashes the pipeline — on any load failure it falls back to
    defaults so the run proceeds (degraded) rather than aborting.

    Sets in state: profile, survey_settings, parent_checkpoint, prior_checkpoints,
    watermark, new_response_ids (automated), window_start/window_end (manual/refresh),
    sample_ids/sample_stats (manual/refresh), metric_snapshots, config_hash,
    is_bootstrap, skip_run/skip_reason, skip_report.
    """
    from datetime import datetime as _dt, timezone as _tz, timedelta as _td

    survey_id = state["survey_id"]
    org_id    = state["org_id"]
    run_id    = state["run_id"]
    trigger   = state.get("trigger", "schedule")
    profile   = state.get("profile") or INSIGHT_PROFILE_AUTOMATED
    await _update_heartbeat(run_id)

    # ── Load effective settings (3-level merge) ──────────────────────────────
    try:
        from crystalos.lib.insight_settings import load_insight_settings
        settings = await load_insight_settings(survey_id, org_id)
    except Exception as exc:
        logger.warning("resolve_context_settings_failed", survey_id=survey_id, error=str(exc))
        settings = {}

    # Merge caller config_override on top (highest precedence).
    config_override = state.get("config_override") or {}
    if config_override:
        settings = {**settings, **config_override}

    config_hash = _config_hash(settings)

    # ── enabled-flag routing (04 §16) — automated only ───────────────────────
    is_automated = profile == INSIGHT_PROFILE_AUTOMATED
    skip_report = False
    if is_automated:
        if settings.get("automated_insights_enabled") is False:
            logger.info("resolve_context_automated_disabled", survey_id=survey_id)
            return {
                **state, "profile": profile, "survey_settings": settings,
                "config_hash": config_hash, "skip_run": True,
                "skip_reason": "automated_disabled",
            }
        skip_report = settings.get("automated_report_generation_enabled") is False

    # ── Resolve parent (latest automated) for trail/watermark ─────────────────
    lookback = int(settings.get("prior_checkpoint_lookback", 5) or 5)
    max_age  = settings.get("prior_checkpoint_max_age_days")
    try:
        max_age = int(max_age) if max_age is not None else None
    except (TypeError, ValueError):
        max_age = None
    prior_chain = await walk_parent_chain(survey_id, org_id, lookback, max_age_days=max_age)
    parent = prior_chain[0] if prior_chain else None
    # Fixed 2026-07-04: walk_parent_chain() falls back to the LEGACY
    # survey_insight_checkpoints table when insight_checkpoints_v2 has no rows
    # yet for this survey — necessary for delta/watermark context, but its `id`
    # is a legacy-table primary key, never a row in insight_checkpoints_v2.
    # insight_checkpoints_v2.parent_checkpoint_id has a foreign key to
    # insight_checkpoints_v2(id) itself, so using a legacy id there always
    # fails with a FK violation, silently dropping every checkpoint write for
    # any survey whose only prior history predates the v2 migration. Both
    # tables stamp schema_version (legacy DEFAULT 1, v2 DEFAULT 2) — a parent
    # is only a valid v2 lineage link when it's genuinely from v2.
    is_v2_parent = bool(parent) and parent.get("schema_version") == 2
    parent_ckpt_id = state.get("parent_checkpoint_id") or (
        str(parent.get("id")) if is_v2_parent and parent.get("id") else ""
    )

    # ── Watermark = parent.response_high_watermark; bootstrap → epoch ─────────
    watermark = None
    if parent is not None:
        watermark = parent.get("response_high_watermark")
    # Fixed 2026-07-04: a legacy-only parent must ALSO count as bootstrap, not
    # just have its id blanked above. This state's is_bootstrap gets ANDed
    # with node_ingest's own (correctly v2-based) bootstrap check further
    # downstream — if this stayed False here, that AND silently overrode
    # node_ingest's correct answer, making it treat the run as a narrow
    # incremental fetch (against an empty new_response_ids, since watermark
    # is also None for a legacy parent) instead of the wide historical sample
    # a real first v2 run needs. Confirmed against a real reproduction: a
    # survey whose only prior history was legacy got its checkpoint written
    # successfully (previous fix), but ABSA/topics/sentiment/emotion/effort
    # were never computed for any of its 150 existing responses because
    # node_ingest believed there was nothing new to look at.
    is_bootstrap = parent is None or not is_v2_parent

    out: dict = {
        **state,
        "profile":              profile,
        "survey_settings":      settings,
        "config_hash":          config_hash,
        "parent_checkpoint":    parent,
        "parent_checkpoint_id": parent_ckpt_id,
        "prior_checkpoints":    prior_chain,
        "watermark":            watermark,
        "is_bootstrap":         is_bootstrap,
        "skip_report":          skip_report,
        "skip_run":             False,
    }

    # ── Profile-specific resolution ──────────────────────────────────────────
    if is_automated:
        # new_response_ids via submitted_at > watermark. Bootstrap (watermark None)
        # loads nothing here — node_ingest does the wide bootstrap sample.
        new_ids: set[str] = set()
        max_submitted = None
        if watermark is not None:
            try:
                async with db._pool_conn().connection() as conn:
                    async with conn.cursor() as cur:
                        await cur.execute(
                            """SELECT id, submitted_at FROM responses
                               WHERE survey_id = %s AND submitted_at > %s
                                 AND deleted_at IS NULL""",
                            (survey_id, watermark),
                        )
                        for r in await cur.fetchall():
                            new_ids.add(str(r[0]))
                            if r[1] is not None and (max_submitted is None or r[1] > max_submitted):
                                max_submitted = r[1]
            except Exception as exc:
                logger.warning("resolve_context_new_ids_failed", survey_id=survey_id, error=str(exc))
        out["new_response_ids"] = new_ids

        # Threshold gate (04 §2 step 6): skip when below stream threshold AND not
        # bootstrap AND not a tier milestone. Milestone is detected later by count;
        # here we honour an explicit milestone trigger.
        threshold = int(settings.get("stream_response_threshold", DEFAULT_STREAM_THRESHOLD) or DEFAULT_STREAM_THRESHOLD)
        is_milestone = trigger == "milestone"
        if (not is_bootstrap) and (not is_milestone) and watermark is not None and len(new_ids) < threshold:
            logger.info("resolve_context_below_threshold", survey_id=survey_id,
                        new_responses=len(new_ids), threshold=threshold)
            out["skip_run"] = True
            out["skip_reason"] = "below_threshold"
            return out

        # 1 snapshot for anomaly context.
        out["metric_snapshots"] = await _load_recent_snapshots(survey_id, 1)
        out["window_start"] = None
        out["window_end"]   = None
        return out

    # ── Manual / refresh: resolve window + sample + snapshots ─────────────────
    now = _dt.now(_tz.utc)
    ws = state.get("window_start")
    we = state.get("window_end") or now

    if profile == INSIGHT_PROFILE_REFRESH:
        lookback_days = int(settings.get("refresh_lookback_days", 30) or 30)
        min_count     = int(settings.get("refresh_min_response_count", 25) or 25)
        we = now
        ws = now - _td(days=lookback_days)
        corpus = await _load_response_meta_in_window(survey_id, ws, we)
        # Expand backwards until min_count or 365d cap.
        guard = 0
        while len(corpus) < min_count and (we - ws) < _td(days=365) and guard < 60:
            ws = ws - _td(days=7)
            corpus = await _load_response_meta_in_window(survey_id, ws, we)
            guard += 1
        sample_ids = {str(r["id"]) for r in corpus}
        out["force_regenerate"] = True
        out["sample_ids"]   = sample_ids
        out["sample_stats"] = {"corpus_size": len(corpus), "sampled": len(sample_ids),
                               "window_start": str(ws), "window_end": str(we)}
        out["metric_snapshots"] = await _load_recent_snapshots(survey_id, 5)

    elif profile == INSIGHT_PROFILE_MANUAL_EXPERT:
        if ws is None:
            ws = now - _td(days=90)
        corpus = await _load_response_meta_in_window(survey_id, ws, we)
        full_cap = int(settings.get("manual_expert_full_corpus_cap", 500) or 500)
        max_corpus = int(settings.get("manual_expert_max_corpus", 2000) or 2000)
        if len(corpus) <= full_cap:
            sample_ids = {str(r["id"]) for r in corpus}
        else:
            from crystalos.tools.sampling import stratified_sample
            sample_ids = set(stratified_sample(corpus, max_corpus))
        snap_n = int(settings.get("manual_expert_snapshot_count", 5) or 5)
        out["force_regenerate"] = True
        out["sample_ids"]   = sample_ids
        out["sample_stats"] = {"corpus_size": len(corpus), "sampled": len(sample_ids),
                               "window_start": str(ws), "window_end": str(we)}
        out["metric_snapshots"] = await _load_recent_snapshots(survey_id, snap_n)

    elif profile == INSIGHT_PROFILE_MANUAL_QUICK:
        if ws is None:
            wdays = int(settings.get("manual_quick_default_window_days", 14) or 14)
            ws = now - _td(days=wdays)
        corpus = await _load_response_meta_in_window(survey_id, ws, we)
        cap = int(settings.get("manual_quick_sample_cap", 150) or 150)
        from crystalos.tools.sampling import recency_weighted_sample
        sample_ids = set(recency_weighted_sample(corpus, cap))
        snap_n = int(settings.get("manual_quick_snapshot_count", 2) or 2)
        out["force_regenerate"] = True
        out["sample_ids"]   = sample_ids
        out["sample_stats"] = {"corpus_size": len(corpus), "sampled": len(sample_ids),
                               "window_start": str(ws), "window_end": str(we)}
        out["metric_snapshots"] = await _load_recent_snapshots(survey_id, snap_n)

    out["window_start"] = ws
    out["window_end"]   = we
    # Manual/refresh do not use the automated watermark path.
    out["new_response_ids"] = out.get("sample_ids", set())

    # Empty window guard for manual profiles (12 error-handling: 400 empty_window).
    if profile in _MANUAL_PROFILES and not out.get("sample_ids"):
        out["skip_run"] = True
        out["skip_reason"] = "empty_window"

    logger.info("resolve_context_done", survey_id=survey_id, profile=profile,
                is_bootstrap=is_bootstrap, parent=parent_ckpt_id or "none",
                sampled=len(out.get("sample_ids", set())) if profile != INSIGHT_PROFILE_AUTOMATED
                else len(out.get("new_response_ids", set())))
    return out


async def _load_recent_snapshots(survey_id: str, limit: int) -> list[dict]:
    """Load the last N survey_metric_snapshots (newest first). Never raises."""
    if limit <= 0:
        return []
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT * FROM survey_metric_snapshots
                       WHERE survey_id = %s
                       ORDER BY captured_at DESC LIMIT %s""",
                    (survey_id, limit),
                )
                rows = await cur.fetchall()
                if not rows:
                    return []
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, r)) for r in rows]
    except Exception as exc:
        logger.warning("load_recent_snapshots_failed", survey_id=survey_id, error=str(exc))
        return []


async def _load_response_meta_in_window(survey_id: str, ws, we) -> list[dict]:
    """Load lightweight response metadata in [ws, we] for sampling. Never raises.

    Uses submitted_at (the responses table has no created_at) and excludes soft-deleted.
    """
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT id, submitted_at, nps_score, ai_sentiment, ai_sentiment_score
                       FROM responses
                       WHERE survey_id = %s AND deleted_at IS NULL
                         AND submitted_at >= %s AND submitted_at <= %s""",
                    (survey_id, ws, we),
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]
                out = []
                for r in rows:
                    d = dict(zip(cols, r))
                    out.append({
                        "id": str(d.get("id")),
                        "submitted_at": d.get("submitted_at"),
                        "nps_score": d.get("nps_score"),
                        "sentiment": d.get("ai_sentiment"),
                        "sentiment_score": d.get("ai_sentiment_score"),
                    })
                return out
    except Exception as exc:
        logger.warning("load_response_meta_window_failed", survey_id=survey_id, error=str(exc))
        return []


# ── Node: ingest ──────────────────────────────────────────────────────────────

async def node_ingest(state: dict) -> dict:
    survey_id = state["survey_id"]
    org_id    = state["org_id"]
    run_id    = state["run_id"]
    user_id   = state.get("user_id", "")

    await _update_heartbeat(run_id)

    # ── resolve_context skip short-circuit (v2) ───────────────────────────────
    # When resolve_context aborted (below threshold / automated disabled / empty
    # window), mark the run completed-skipped and pass through with no data so the
    # remaining nodes no-op. node_publish honours skip_run too as a backstop.
    if state.get("skip_run"):
        reason = state.get("skip_reason", "skipped")
        logger.info("node_ingest_skip_run", survey_id=survey_id, reason=reason)
        try:
            async with db._pool_conn().connection() as conn:
                await conn.execute(
                    """UPDATE agent_runs SET status='completed', completed_at=NOW()
                       WHERE id=%s""",
                    (run_id,),
                )
        except Exception:
            pass
        await _emit_event(run_id, "run_complete", "resolve_context",
                          {"skipped": True, "reason": reason})
        return {**state, "responses": [], "errors": state.get("errors", [])}

    # Set up async-safe trace context so all log lines in this pipeline run
    # carry run_id, org_id, and trace_id without explicit threading.
    from crystalos.lib.trace_context import set_trace_context
    from crystalos.lib.event_publisher import publish_run_event
    set_trace_context(run_id=run_id, org_id=org_id)
    structlog.contextvars.bind_contextvars(run_id=run_id, org_id=org_id)

    await publish_run_event("run_started", run_id=run_id, org_id=org_id, survey_id=survey_id)

    # G25 — Idempotency lock: prevent concurrent pipeline runs for the same survey.
    # pg_try_advisory_xact_lock is transaction-scoped and auto-released on commit/rollback.
    # Hash collisions are astronomically unlikely (2^63 space) for survey UUIDs.
    try:
        async with db._pool_conn().connection() as _lock_conn:
            async with _lock_conn.cursor() as _lock_cur:
                await _lock_cur.execute(
                    "SELECT pg_try_advisory_xact_lock(hashtext('insight_gen:' || %s::text))",
                    (survey_id,),
                )
                got_lock = (await _lock_cur.fetchone())[0]
    except Exception as _lock_exc:
        logger.debug("advisory_lock_check_failed", error=str(_lock_exc))
        got_lock = True  # If lock check fails, proceed — don't block on infra error

    if not got_lock:
        # Another pipeline run is in progress for this survey.
        # Find its run_id and return a non-error so the caller can poll that run.
        existing_run_id: str | None = None
        try:
            async with db._pool_conn().connection() as _c:
                async with _c.cursor() as _cur:
                    await _cur.execute(
                        """SELECT id FROM agent_runs
                           WHERE survey_id = %s AND status = 'running'
                           ORDER BY created_at DESC LIMIT 1""",
                        (survey_id,),
                    )
                    row = await _cur.fetchone()
                    if row:
                        existing_run_id = str(row[0])
        except Exception:
            pass
        logger.info("pipeline_already_running", survey_id=survey_id, existing_run=existing_run_id)
        return {**state, "errors": state["errors"] + [
            f"Pipeline already running for survey {survey_id}. Run: {existing_run_id or 'unknown'}"
        ]}

    # Guard: verify org owns this survey before any data reaches the LLM context
    if not await db.check_survey_access(survey_id, user_id, org_id):
        return {**state, "errors": state["errors"] + [f"Survey {survey_id} not found or access denied"]}

    # Load survey
    survey = None
    async with db._pool_conn().connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT * FROM surveys WHERE id = %s AND org_id = %s AND deleted_at IS NULL",
                (survey_id, org_id),
            )
            row = await cur.fetchone()
            if row is not None:
                cols = [desc[0] for desc in cur.description]
                survey = dict(zip(cols, row))

    if not survey:
        return {**state, "errors": state["errors"] + [f"Survey {survey_id} not found"]}

    questions = survey.get("questions") or []
    if isinstance(questions, str):
        questions = json.loads(questions)

    flags = compute_survey_capability_flags(questions)

    # Bootstrap detection: if no topic centroids exist this is the first run.
    # First run loads more responses to seed the centroid registry; incremental
    # runs load fewer (metrics window) and cap new-response processing at 50.
    # Insight Pipeline v2: resolve_context sets is_bootstrap from parent-checkpoint
    # absence — prefer it when present; centroid presence is the fallback signal.
    is_bootstrap = True
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT 1 FROM survey_topic_centroids WHERE survey_id = %s LIMIT 1",
                    (survey_id,),
                )
                is_bootstrap = await cur.fetchone() is None
    except Exception:
        pass  # table may not exist yet — treat as bootstrap
    if "is_bootstrap" in state and state.get("profile"):
        # v2 path: resolve_context already decided bootstrap (no parent checkpoint).
        # A survey can have centroids but no checkpoint chain (pre-v2 data); honour
        # resolve_context's signal so the watermark/delta logic stays consistent,
        # but never claim bootstrap when centroids exist (would re-seed duplicates).
        is_bootstrap = bool(state["is_bootstrap"]) and is_bootstrap

    force_regenerate = state.get("force_regenerate", False)
    profile = state.get("profile") or INSIGHT_PROFILE_AUTOMATED

    # Manual runs (force_regenerate=True) get the same wide sample as bootstrap
    # so the user always receives the highest-quality picture, not an incremental window.
    response_limit = (
        INGEST_MAX_RESPONSES_BOOTSTRAP
        if (is_bootstrap or force_regenerate)
        else INGEST_MAX_RESPONSES_CAP
    )
    new_response_cap = INGEST_NEW_RESPONSE_ABSA_CAP

    # ── v2 manual/refresh: load exactly the resolved sample window ─────────────
    # resolve_context computed sample_ids (stratified/recency) for manual_expert,
    # manual_quick, and refresh. Load just those rows — no stratified re-sampling.
    # The sample is already capped in resolve_context; we trust it here. Sets
    # _manual_response_rows so the stratified-sampling block below is skipped.
    _v2_sample_ids = state.get("sample_ids") or set()
    _manual_response_rows: list[dict] | None = None
    if profile in (INSIGHT_PROFILE_MANUAL_EXPERT, INSIGHT_PROFILE_MANUAL_QUICK,
                   INSIGHT_PROFILE_REFRESH) and _v2_sample_ids:
        try:
            async with db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """SELECT id, answers, submitted_at,
                                  ai_enriched_at, ai_sentiment, ai_sentiment_score,
                                  ai_emotion, ai_effort_score, nps_score, ai_topics
                           FROM responses
                           WHERE survey_id = %s AND id = ANY(%s) AND deleted_at IS NULL
                           ORDER BY submitted_at ASC NULLS LAST""",
                        (survey_id, list(_v2_sample_ids)),
                    )
                    rows = await cur.fetchall()
                    cols = [desc[0] for desc in cur.description]
                    _manual_response_rows = [dict(zip(cols, r)) for r in rows]
        except Exception as exc:
            logger.warning("node_ingest_manual_sample_load_failed", error=str(exc))
            _manual_response_rows = None

    # ── Stratified response sampling ─────────────────────────────────────────
    # Goal: load a representative sample of responses across the survey's lifetime.
    # A simple ORDER BY submitted_at DESC LIMIT N causes permanent recency bias —
    # a 6-month survey with 10,000 responses would always ignore months 1-5.
    #
    # Strategy (three tiers based on total response count):
    #
    #   Tier 1 — Small survey (total ≤ cap):
    #     Load everything directly. No sampling overhead.
    #
    #   Tier 2 — Medium survey (cap < total ≤ INGEST_LARGE_SURVEY_THRESHOLD):
    #     COUNT(*) first (cheap index scan), then load all IDs into Python,
    #     sample in-process. Acceptable at <1,000 rows (~30KB payload).
    #
    #   Tier 3 — Large survey (total > INGEST_LARGE_SURVEY_THRESHOLD):
    #     Use SQL NTILE to divide the survey lifetime into time buckets and sample
    #     directly in Postgres. Never loads more than `cap` rows into Python,
    #     regardless of how many responses exist (10,000 or 10,000,000).
    #
    # In all tiers, an anchor set of extreme-NPS responses (0-3 detractors and
    # 9-10 promoters) is loaded separately and merged in. These are highest-signal
    # for topic discovery (clear pain/delight) and are always included.

    response_rows: list[dict] = []
    _total_available  = 0
    _survey_age_days  = 0.0
    _used_sql_ntile   = False

    # v2 manual/refresh fast path: sample already resolved by resolve_context.
    # Setting _total_available high makes every tier branch a no-op (total > limit
    # but the merged-id queries below all key off selected ids we override after).
    # We simply skip the whole sampling block when the manual rows are present.
    _skip_stratified = _manual_response_rows is not None

    try:
        if _skip_stratified:
            raise _ManualSampleLoaded()  # jump to the manual-assignment handler below
        # ── Step 1: Count responses and measure survey lifespan ───────────────
        # MIN/MAX submitted_at adds negligible cost — same index scan as COUNT(*).
        # The age drives dynamic bucket count so each bucket ≈ a consistent
        # calendar window regardless of how long the survey has been running.
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT COUNT(*), MIN(submitted_at), MAX(submitted_at)
                       FROM responses WHERE survey_id = %s""",
                    (survey_id,),
                )
                row = await cur.fetchone()
                if row:
                    _total_available = int(row[0]) if row[0] else 0
                    _min_ts, _max_ts = row[1], row[2]
                    if _min_ts and _max_ts and _max_ts > _min_ts:
                        _survey_age_days = (_max_ts - _min_ts).total_seconds() / 86400.0

        n_buckets = compute_stratified_buckets(_survey_age_days)

        if _total_available <= response_limit:
            # ── Tier 1: load everything ───────────────────────────────────────
            async with db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """SELECT id, answers, submitted_at,
                                  ai_enriched_at, ai_sentiment, ai_sentiment_score,
                                  ai_emotion, ai_effort_score, nps_score, ai_topics
                           FROM responses
                           WHERE survey_id = %s
                           ORDER BY submitted_at ASC NULLS LAST""",
                        (survey_id,),
                    )
                    rows = await cur.fetchall()
                    cols = [desc[0] for desc in cur.description]
                    response_rows = [dict(zip(cols, r)) for r in rows]

        elif _total_available <= INGEST_LARGE_SURVEY_THRESHOLD:
            # ── Tier 2: Python-side stratified sampling ───────────────────────
            async with db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """SELECT id, submitted_at, nps_score
                           FROM responses
                           WHERE survey_id = %s
                           ORDER BY submitted_at ASC NULLS LAST""",
                        (survey_id,),
                    )
                    meta_rows = await cur.fetchall()

            selected_ids_set: set[str] = set()

            # Anchor: extreme-NPS responses (promoters 9-10, detractors 0-3)
            anchor_ids: list[str] = []
            for rid, _ts, nps in meta_rows:
                if nps is not None:
                    try:
                        if float(nps) <= 3 or float(nps) >= 9:
                            anchor_ids.append(str(rid))
                    except (TypeError, ValueError):
                        pass
            selected_ids_set.update(anchor_ids[:INGEST_ANCHOR_RESPONSES])

            # Stratified time-bucket sampling
            slots = max(1, response_limit - len(selected_ids_set))
            per_bucket  = max(1, slots // n_buckets)
            bucket_size = max(1, _total_available // n_buckets)

            for b in range(n_buckets):
                start  = b * bucket_size
                end    = start + bucket_size if b < n_buckets - 1 else _total_available
                bucket = [str(r[0]) for r in meta_rows[start:end] if str(r[0]) not in selected_ids_set]
                if len(bucket) <= per_bucket:
                    selected_ids_set.update(bucket)
                else:
                    # Evenly-spaced selection within the bucket preserves time distribution
                    step    = len(bucket) / per_bucket
                    sampled = [bucket[int(i * step)] for i in range(per_bucket)]
                    selected_ids_set.update(sampled)

            selected_ids = list(selected_ids_set)[:response_limit]
            if selected_ids:
                async with db._pool_conn().connection() as conn:
                    async with conn.cursor() as cur:
                        await cur.execute(
                            """SELECT id, answers, submitted_at,
                                      ai_enriched_at, ai_sentiment, ai_sentiment_score,
                                      ai_emotion, ai_effort_score, nps_score, ai_topics
                               FROM responses
                               WHERE survey_id = %s AND id = ANY(%s)
                               ORDER BY submitted_at ASC NULLS LAST""",
                            (survey_id, selected_ids),
                        )
                        rows = await cur.fetchall()
                        cols = [desc[0] for desc in cur.description]
                        response_rows = [dict(zip(cols, r)) for r in rows]

        else:
            # ── Tier 3: SQL NTILE sampling for large surveys ──────────────────
            # Divides the survey's response timeline into n_buckets equal-size
            # time windows and samples per_bucket rows from each using ORDER BY id
            # (UUID — deterministic, effectively random within each window).
            # Never loads more than `response_limit` rows into Python regardless
            # of total survey size.
            _used_sql_ntile = True
            per_bucket = max(1, (response_limit - INGEST_ANCHOR_RESPONSES) // n_buckets)

            async with db._pool_conn().connection() as conn:
                # Anchor query (extreme NPS) — runs separately, fast with index
                async with conn.cursor() as cur:
                    await cur.execute(
                        """SELECT id FROM responses
                           WHERE survey_id = %s
                             AND nps_score IS NOT NULL
                             AND (nps_score <= 3 OR nps_score >= 9)
                           ORDER BY id
                           LIMIT %s""",
                        (survey_id, INGEST_ANCHOR_RESPONSES),
                    )
                    anchor_ids_sql = [str(r[0]) for r in await cur.fetchall()]

                # NTILE stratified sample
                async with conn.cursor() as cur:
                    await cur.execute(
                        """WITH bucketed AS (
                               SELECT id,
                                      NTILE(%s) OVER (ORDER BY submitted_at ASC NULLS LAST) AS bucket
                               FROM responses
                               WHERE survey_id = %s
                           ),
                           ranked AS (
                               SELECT id,
                                      ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY id) AS rn
                               FROM bucketed
                           )
                           SELECT id FROM ranked
                           WHERE rn <= %s
                           ORDER BY id
                           LIMIT %s""",
                        (n_buckets, survey_id, per_bucket, response_limit),
                    )
                    ntile_ids = [str(r[0]) for r in await cur.fetchall()]

                # Merge anchor + NTILE sample, deduplicate, respect cap
                merged_ids = list({*anchor_ids_sql, *ntile_ids})[:response_limit]

                if merged_ids:
                    async with conn.cursor() as cur:
                        await cur.execute(
                            """SELECT id, answers, submitted_at,
                                      ai_enriched_at, ai_sentiment, ai_sentiment_score,
                                      ai_emotion, ai_effort_score, nps_score, ai_topics
                               FROM responses
                               WHERE survey_id = %s AND id = ANY(%s)
                               ORDER BY submitted_at ASC NULLS LAST""",
                            (survey_id, merged_ids),
                        )
                        rows = await cur.fetchall()
                        cols = [desc[0] for desc in cur.description]
                        response_rows = [dict(zip(cols, r)) for r in rows]

        logger.info(
            "node_ingest_sampling",
            survey_id=survey_id,
            total_available=_total_available,
            selected=len(response_rows),
            cap=response_limit,
            n_buckets=n_buckets,
            survey_age_days=round(_survey_age_days, 1),
            is_bootstrap=is_bootstrap,
            force_regenerate=force_regenerate,
            sql_ntile=_used_sql_ntile,
        )

    except _ManualSampleLoaded:
        # v2 manual/refresh: response_rows already loaded from resolve_context sample.
        response_rows = _manual_response_rows or []
        _total_available = len(response_rows)
        logger.info("node_ingest_manual_sample", survey_id=survey_id,
                    selected=len(response_rows), profile=profile)
    except Exception as exc:
        # Fallback: simple recency-based query — never fails the pipeline
        logger.warning("node_ingest_stratified_failed", error=str(exc))
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT id, answers, submitted_at,
                              ai_enriched_at, ai_sentiment, ai_sentiment_score,
                              ai_emotion, ai_effort_score, nps_score, ai_topics
                       FROM responses
                       WHERE survey_id = %s
                       ORDER BY submitted_at DESC NULLS LAST
                       LIMIT %s""",
                    (survey_id, response_limit),
                )
                rows = await cur.fetchall()
                cols = [desc[0] for desc in cur.description]
                response_rows = [dict(zip(cols, r)) for r in rows]

    responses = []
    for r in response_rows:
        answers = r.get("answers") or []
        if isinstance(answers, str):
            answers = json.loads(answers)
        r["answers"] = answers
        for answer in answers:
            q = next((q for q in questions if q.get("id") == answer.get("questionId")), None)
            if q:
                if q.get("type") == "nps":
                    try:
                        r["nps_score"] = int(answer["value"])
                    except (ValueError, TypeError, KeyError):
                        pass
                elif q.get("type") == "csat":
                    try:
                        r["csat_score"] = float(answer["value"])
                    except (ValueError, TypeError, KeyError):
                        pass
                elif q.get("type") == "ces":
                    try:
                        r["ces_score"] = float(answer["value"])
                    except (ValueError, TypeError, KeyError):
                        pass
                elif q.get("type") == "rating":
                    try:
                        r["rating_score"] = float(answer["value"])
                    except (ValueError, TypeError, KeyError):
                        pass
        responses.append(r)

    # Load org profile for specialist routing (industry, use_case, etc.)
    org_profile = {}
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT industry, company_size, use_case, target_audience,
                              brand_description, brand_name, sub_vertical, region
                       FROM org_profiles WHERE org_id = %s""",
                    (org_id,),
                )
                row = await cur.fetchone()
                if row is not None:
                    cols = [desc[0] for desc in cur.description]
                    org_profile = dict(zip(cols, row))
    except Exception:
        pass  # org_profiles table or sub_vertical/region columns may not exist yet — graceful

    # Inject org context into survey dict so node_context can pick it up
    survey["org_context"] = {
        "industry":         org_profile.get("industry") or "general",
        "sub_vertical":     org_profile.get("sub_vertical") or "",
        "size_band":        org_profile.get("company_size") or "mid_market",
        "region":           org_profile.get("region") or "global",
        "primary_use_case": org_profile.get("use_case") or "CX",
    }

    # Also inject per-survey context from survey metadata if present
    metadata = survey.get("metadata") or {}
    if isinstance(metadata, str):
        try:
            import json as _json
            metadata = _json.loads(metadata)
        except Exception:
            metadata = {}
    survey["metadata"] = metadata

    # Track which responses need processing this run.
    # Includes two cases:
    #   (a) Never ABSA-enriched — fully new responses
    #   (b) ABSA-enriched but missing ai_topics — bootstrap orphans that clustered
    #       below threshold and got stranded without topic tags on the first run
    all_new_ids: set[str] = {
        str(r["id"]) for r in responses
        if not (r.get("ai_enriched_at") and r.get("ai_sentiment") and r.get("ai_emotion"))
        or (r.get("ai_enriched_at") and not r.get("ai_topics"))
    }
    # v2 automated_incremental: restrict to responses after the parent watermark.
    # resolve_context computed new_response_ids via submitted_at > watermark; only
    # those are processed (do not re-enrich pre-watermark verbatims — 04 §3 critical
    # rule). Bootstrap keeps the full enrichment-based set.
    _wm_new_ids = state.get("new_response_ids") or set()
    if profile == INSIGHT_PROFILE_AUTOMATED and not is_bootstrap and _wm_new_ids:
        all_new_ids = all_new_ids & set(_wm_new_ids)
    # Incremental runs: cap new responses to process at 50 (newest first).
    # Metrics run on the full loaded set; clustering/ABSA only touches the cap.
    if not is_bootstrap and len(all_new_ids) > new_response_cap:
        # Sort by submitted_at descending to prefer the newest unenriched responses.
        id_to_ts = {str(r["id"]): r.get("submitted_at") or "" for r in responses}
        new_response_ids: set[str] = set(
            sorted(all_new_ids, key=lambda rid: id_to_ts.get(rid, ""), reverse=True)[:new_response_cap]
        )
    else:
        new_response_ids = all_new_ids

    # Load prior metric snapshots for longitudinal NPS/CSAT comparison
    prior_snapshots: list[dict] = []
    try:
        prior_snapshots = await db.get_prior_metric_snapshots(survey_id, limit=5)
    except Exception as exc:
        logger.warning("node_ingest_prior_snapshots_failed", error=str(exc))

    # Load response count from most recent report.* insight for tiered report delta check
    last_report_response_count = 0
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT metric_json->>'response_count'
                       FROM insights
                       WHERE survey_id = %s AND org_id = %s
                         AND category LIKE 'report.%%'
                         AND superseded_at IS NULL
                       ORDER BY generated_at DESC
                       LIMIT 1""",
                    (survey_id, org_id),
                )
                row = await cur.fetchone()
                if row and row[0]:
                    last_report_response_count = int(row[0])
    except Exception:
        pass

    # Persist response count so the scheduler can skip re-runs on unchanged data.
    try:
        async with db._pool_conn().connection() as conn:
            await conn.execute(
                "UPDATE agent_runs SET stream_events = stream_events || %s::jsonb WHERE id = %s",
                (json.dumps([{"event": "response_count", "count": len(responses)}]), run_id),
            )
            await conn.commit()
    except Exception:
        pass

    await _emit_event(run_id, "node_complete", "ingest", {
        "survey_id": survey_id, "response_count": len(responses),
        "new_response_count": len(new_response_ids),
        "industry": survey["org_context"]["industry"],
        "prior_snapshots": len(prior_snapshots),
    })

    return {
        **state,
        "survey":                      survey,
        "responses":                   responses,
        "new_response_ids":            new_response_ids,
        "force_regenerate":            state.get("force_regenerate", False),
        "is_bootstrap":                is_bootstrap,
        "has_open_text":               flags["has_open_text"],
        "has_nps":                     flags["has_nps"],
        "has_csat":                    flags["has_csat"],
        "has_ces":                     flags["has_ces"],
        "survey_questions":            questions,
        "prior_snapshots":             prior_snapshots,
        "last_report_response_count":  last_report_response_count,
        "narrate_attempt":             0,
    }


# ── Node: embed ───────────────────────────────────────────────────────────────

async def node_embed(state: dict) -> dict:
    """Embed open-text responses using OpenAI (or heuristic fallback).

    Runs after ingest and before the parallel metrics/extract_texts split.
    Stores embeddings in the DB cache via get_or_create_embeddings.
    """
    survey_id = state["survey_id"]
    org_id    = state["org_id"]
    run_id    = state["run_id"]
    responses = state["responses"]
    survey    = state["survey"]

    await _update_heartbeat(run_id)

    if not state.get("has_open_text", True):
        logger.info("node_embed_skipped_no_text_survey", survey_id=state.get("survey_id"))
        return {**state, "embedded_texts": []}

    # Extract open texts first so we know what to embed
    questions = survey.get("questions") or []
    if isinstance(questions, str):
        import json as _json
        questions = _json.loads(questions)

    raw_texts = extract_open_texts(responses, questions)

    # Tag each text with org/survey for embed_texts call
    tagged_texts = [
        {**t, "org_id": org_id, "survey_id": survey_id}
        for t in raw_texts
    ]

    embedded_texts = []
    try:
        async with db._pool_conn().connection() as conn:
            embedded_texts = await get_or_create_embeddings(tagged_texts, conn)
    except Exception as exc:
        logger.warning("node_embed_failed", error=str(exc))
        # Fall through — clustering will use heuristic if no embeddings
        embedded_texts = raw_texts

    await _emit_event(run_id, "node_complete", "embed", {
        "embedded_count": len(embedded_texts),
        "has_embeddings": any(t.get("embedding") for t in embedded_texts),
    })

    return {**state, "embedded_texts": embedded_texts}


# ── Node: metrics ─────────────────────────────────────────────────────────────

async def node_metrics(state: dict) -> dict:
    responses = state["responses"]
    run_id    = state["run_id"]

    await _update_heartbeat(run_id)

    metrics: dict = {}
    if any(r.get("nps_score") is not None for r in responses):
        metrics["nps"] = compute_nps_ci(responses)
    if any(r.get("csat_score") is not None for r in responses):
        metrics["csat"] = compute_csat(responses)
    if any(r.get("ces_score") is not None for r in responses):
        metrics["ces"] = compute_ces(responses)
    metrics["completion"] = compute_completion_rate(responses)
    metrics["total_responses"] = len(responses)

    # Extended trend analysis (replaces bare daily dict)
    metrics["trend"] = compute_response_trend_analysis(responses)

    # Effort score over all open texts (embedded_texts is available before parallel split)
    effort_texts = state.get("embedded_texts") or []
    if effort_texts:
        all_text_strs = [t["text"] for t in effort_texts]
        metrics["effort_score"] = compute_effort_score(all_text_strs)

    await _emit_event(run_id, "node_complete", "metrics", {
        "metrics": {k: v for k, v in metrics.items() if k not in ("trend",)},
    })

    return {"metrics": metrics}


# ── Node: extract_texts ───────────────────────────────────────────────────────

async def node_extract_texts(state: dict) -> dict:
    await _update_heartbeat(state["run_id"])
    questions = (state["survey"].get("questions") or [])
    if isinstance(questions, str):
        questions = json.loads(questions)

    # Reuse texts from node_embed (already extracted + tagged) to avoid a second
    # full pass over responses. Strip org_id/survey_id/embedding added by node_embed.
    embedded = state.get("embedded_texts") or []
    if embedded:
        texts = [
            {"response_id": t["response_id"], "question_id": t["question_id"], "text": t["text"]}
            for t in embedded
        ]
    else:
        # node_embed must have been skipped or failed before populating state — recompute
        texts = extract_open_texts(state["responses"], questions)

    # Detailed diagnostics to pinpoint ID mismatches or storage issues
    q_ids   = [q.get("id") for q in questions]
    q_types = {q.get("id"): q.get("type") for q in questions}
    # Collect unique questionIds seen across all response answers
    answer_qids: set[str] = set()
    for r in state["responses"]:
        for a in (r.get("answers") or []):
            qid = a.get("questionId") or a.get("question_id") or a.get("id")
            if qid:
                answer_qids.add(str(qid))
    matched_qids  = answer_qids & set(str(q) for q in q_ids if q)
    unmatched_ans = answer_qids - set(str(q) for q in q_ids if q)

    type_counts: dict[str, int] = {}
    for t in texts:
        qt = q_types.get(t["question_id"], "unknown")
        type_counts[qt] = type_counts.get(qt, 0) + 1

    logger.info(
        "node_extract_texts",
        total=len(texts),
        by_type=type_counts,
        response_count=len(state["responses"]),
        question_count=len(questions),
        question_ids_sample=q_ids[:5],
        question_types=list(q_types.values()),
        answer_qids_sample=list(answer_qids)[:5],
        matched_qids_count=len(matched_qids),
        unmatched_answer_qids=list(unmatched_ans)[:5],
    )
    if not texts:
        logger.warning(
            "node_extract_texts_empty",
            question_count=len(questions),
            answer_qids_sample=list(answer_qids)[:5],
            hint=(
                "question_count=0 → questions not loaded from survey JSONB"
                if not questions else
                f"0/{len(answer_qids)} answer questionIds matched {len(questions)} question ids — likely ID mismatch"
                if answer_qids and not matched_qids else
                "No extractable texts — check answer values are non-null"
            ),
        )

    return {"open_texts": texts}


# ── Node: absa ────────────────────────────────────────────────────────────────

async def node_absa(state: dict) -> dict:
    texts  = state["open_texts"]
    run_id = state["run_id"]
    await _update_heartbeat(run_id)
    if not state.get("has_open_text", True):
        logger.info("node_absa_skipped_no_text_survey", survey_id=state.get("survey_id"))
        return {**state, "absa_results": []}
    if not texts:
        return state

    # Guard: skip LLM ABSA batch for trivially small text sets — not worth the cost
    if len(texts) < 3:
        logger.info("node_absa_skipped_insufficient_texts", text_count=len(texts))
        await _emit_event(run_id, "node_complete", "absa", {
            "analyzed_count": 0, "skipped": "insufficient_texts", "min_required": 3,
        })
        return {**state, "absa_results": []}

    from crystalos.lib.models import get_absa_config
    absa_cfg = get_absa_config()

    # ── Split: already-enriched vs new ───────────────────────────────────────
    # Build lookup from response_id → response row (only enriched ones)
    enriched_lookup: dict[str, dict] = {}
    for r in state.get("responses", []):
        # Only treat as enriched when BOTH sentiment and emotion are populated.
        # If either is null the first run had a bug — re-enrich to correct it.
        if r.get("ai_enriched_at") and r.get("ai_sentiment") and r.get("ai_emotion"):
            enriched_lookup[str(r["id"])] = r

    synthetic_results: list[dict] = []
    new_texts: list[dict] = []

    for t in texts:
        rid = str(t["response_id"])
        if rid in enriched_lookup:
            r = enriched_lookup[rid]
            # Reconstruct ABSA result from stored DB fields — no LLM needed.
            # Use the first previously-discovered topic as the aspect hint so
            # cached responses cluster under meaningful labels on second+ runs
            # rather than all collapsing into the "general" bucket.
            cached_score  = float(r.get("ai_sentiment_score") or 0.0)
            stored_topics = r.get("ai_topics") or []
            if isinstance(stored_topics, str):
                import json as _json
                try:
                    stored_topics = _json.loads(stored_topics)
                except Exception:
                    stored_topics = []
            aspect_hint = stored_topics[0] if stored_topics else "general"
            synthetic_results.append({
                "response_id": t["response_id"],
                "question_id": t["question_id"],
                "text":        t["text"],
                "aspect":      aspect_hint,
                "sentiment":   r.get("ai_sentiment") or _score_to_sentiment(cached_score),
                "score":       cached_score,
                "emotion":     r.get("ai_emotion") or detect_dominant_emotion(t["text"]),
            })
        else:
            new_texts.append(t)

    # ── Cap new texts by env (stratified sample if over cap) ─────────────────
    cap = absa_cfg["cap"]
    if len(new_texts) > cap:
        import random as _random
        # Stratified sample: keep proportional representation across the list
        # (texts are ordered newest-first from ingest; shuffle then sample)
        new_texts = _random.sample(new_texts, cap)

    # ── Run parallel ABSA on new texts ────────────────────────────────────────
    llm_results: list[dict] = []
    if new_texts:
        import asyncio as _asyncio

        sem = _asyncio.Semaphore(absa_cfg["concurrency"])

        async def _llm_func(prompt: str) -> str:
            # ABSA batches of 25 items need ~600-900 tokens of output;
            # default 1000 is too tight and causes truncated JSON.
            return await _llm_raw(prompt, max_tokens=2500)

        _survey      = state.get("survey", {})
        _title       = (_survey.get("title") or "").strip()
        _intent      = (_survey.get("intent") or "").strip()
        survey_context = f"{_title}" + (f" — {_intent}" if _intent else "")

        llm_results = await run_absa_llm(
            new_texts,
            _llm_func,
            batch_size=absa_cfg["batch_size"],
            semaphore=sem,
            survey_context=survey_context,
        )

    # Combine: new responses first so they seed clusters before old ones.
    # The greedy cosine clustering is order-sensitive — whichever item comes
    # first in the list seeds a cluster and sweeps all remaining unassigned items.
    # Putting new responses first gives them priority to form new clusters instead
    # of being absorbed into an existing old-topic cluster at the 0.72 threshold.
    results = llm_results + synthetic_results

    # ── Write per-response AI signals back to the responses table ────────────
    # Only write back newly processed texts — enriched ones already have correct DB state.
    # Group results by response_id; take dominant sentiment/emotion across
    # all open-text answers for that response. Zero extra LLM calls.
    try:
        from collections import defaultdict as _dd
        by_resp: dict[str, list] = _dd(list)
        for r in llm_results:
            by_resp[str(r["response_id"])].append(r)

        updates = []
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
            updates.append((dom_sentiment, round(avg_score, 2), dom_emotion, round(effort, 1), resp_id))

        if updates:
            async with db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    await cur.executemany(
                        """UPDATE responses
                           SET ai_sentiment=%s, ai_sentiment_score=%s,
                               ai_emotion=%s, ai_effort_score=%s,
                               ai_enriched_at=NOW()
                           WHERE id=%s""",
                        updates,
                    )
                await conn.commit()
            logger.info("node_absa_writeback", count=len(updates))
    except Exception as exc:
        logger.error("node_absa_writeback_failed", error=str(exc), traceback=traceback.format_exc())

    await _emit_event(run_id, "node_complete", "absa", {"analyzed_count": len(results)})
    return {**state, "absa_results": results}


# ── Node: cluster ─────────────────────────────────────────────────────────────

def _make_cluster_from_items(
    idx: int,
    items: list[dict],
    total_size: int | None = None,
    canonical_name: str | None = None,
    is_new_topic: bool = False,
    centroid: list[float] | None = None,
) -> dict:
    """Build a cluster dict from a list of ABSA result items."""
    if not items:
        return {}
    avg_score = sum(i.get("score", 0.0) for i in items) / len(items)
    neg = sum(1 for i in items if i.get("sentiment") == "negative")
    pos = sum(1 for i in items if i.get("sentiment") == "positive")
    dom_sentiment = "negative" if neg > pos else ("positive" if pos > neg else "neutral")
    emotion_counts: dict[str, int] = {}
    for i in items:
        e = i.get("emotion", "neutral")
        emotion_counts[e] = emotion_counts.get(e, 0) + 1
    dom_emotion = max(emotion_counts, key=emotion_counts.get) if emotion_counts else "neutral"
    aspect_counts: dict[str, int] = {}
    for i in items:
        a = i.get("aspect", "general")
        aspect_counts[a] = aspect_counts.get(a, 0) + 1
    aspect = max(aspect_counts, key=aspect_counts.get) if aspect_counts else "general"

    return {
        "id":                  f"cluster_{idx}",
        "aspect":              canonical_name or aspect,
        "canonical_name":      canonical_name,   # set for existing topics; None triggers LLM naming
        "texts":               items,
        "size":                total_size if total_size is not None else len(items),
        "avg_sentiment_score": round(avg_score, 2),
        "dominant_sentiment":  dom_sentiment,
        "dominant_emotion":    dom_emotion,
        "label":               canonical_name,
        "_new_topic":          is_new_topic,
        "_centroid":           centroid,         # stored for node_topics centroid insertion
    }


def _group_unclustered_by_aspect(
    raw_clusters: list[dict],
    all_items: list[dict],
    start_idx: int,
    is_new_topic: bool,
) -> tuple[list[dict], list]:
    """Collect items not in any cluster and group them by ABSA aspect.

    Guarantees every response ends up in some cluster — no silent drops.
    Each unique aspect becomes its own cluster even with a single response.
    Returns (extra_clusters, extra_centroids).
    """
    from collections import defaultdict as _dd

    clustered_rids: set[str] = set()
    for raw in raw_clusters:
        for item in (raw.get("texts") or []):
            clustered_rids.add(str(item.get("response_id")))

    unclustered = [
        item for item in all_items
        if str(item.get("response_id")) not in clustered_rids
        and item.get("response_id") is not None
    ]
    if not unclustered:
        return [], []

    aspect_groups: dict[str, list] = _dd(list)
    for item in unclustered:
        aspect = (item.get("aspect") or "general feedback").strip().lower()
        aspect_groups[aspect].append(item)

    extra_clusters: list[dict] = []
    extra_centroids: list = []
    for aspect, items in sorted(aspect_groups.items(), key=lambda x: -len(x[1])):
        # Compute centroid from embeddings so the topic is usable in incremental ANN.
        embeddings = [item["embedding"] for item in items if item.get("embedding")]
        if embeddings:
            dim = len(embeddings[0])
            centroid = [
                sum(e[d] for e in embeddings) / len(embeddings) for d in range(dim)
            ]
        else:
            centroid = None
        extra_clusters.append(_make_cluster_from_items(
            start_idx + len(extra_clusters) + 1,
            items,
            total_size=len(items),
            canonical_name=None,   # LLM will name it
            is_new_topic=is_new_topic,
            centroid=centroid,
        ))
        extra_centroids.append(centroid)

    return extra_clusters, extra_centroids


async def node_cluster(state: dict) -> dict:
    """Cluster responses into topics.

    Bootstrap mode (first run, no centroids exist):
      Runs the original O(n²) cosine clustering to seed the centroid registry.
      Any responses that don't form a cluster of ≥2 are grouped by ABSA aspect
      into additional clusters so every response gets a topic.
      Stores per-cluster centroids in state["bootstrap_centroids"] for node_topics
      to insert after LLM naming.

    Incremental mode (centroids exist):
      For each new response embedding, runs a single pgvector ANN query against
      survey_topic_centroids. Responses that match (similarity >= 0.72) are
      assigned to the nearest existing topic (Welford centroid update). Responses
      that don't match go into the topic_candidates buffer. When the buffer
      reaches the flush threshold, mini-clustering runs on candidates only to
      detect new emerging topics — these are passed to node_topics for LLM naming.
      Unclustered candidates are also grouped by ABSA aspect so they surface.

    Falls back to bootstrap mode if pgvector queries fail.
    """
    texts  = state["open_texts"]
    run_id = state["run_id"]
    await _update_heartbeat(run_id)
    if not state.get("has_open_text", True):
        logger.info("node_cluster_skipped_no_text_survey", survey_id=state.get("survey_id"))
        return {**state, "clusters": [], "bootstrap_centroids": []}
    if not texts:
        return state

    survey_id       = state["survey_id"]
    org_id          = state["org_id"]
    is_bootstrap    = state.get("is_bootstrap", True)
    new_response_ids = state.get("new_response_ids", set())

    embedded_texts      = state.get("embedded_texts", [])
    has_real_embeddings = any(t.get("embedding") for t in embedded_texts)

    # Build (response_id, question_id) → embedding lookup
    emb_lookup: dict[tuple[str, str], list[float]] = {}
    emb_by_rid: dict[str, list[float]] = {}   # first embedding per response_id
    for t in embedded_texts:
        if t.get("embedding"):
            emb_lookup[(t["response_id"], t["question_id"])] = t["embedding"]
            if str(t["response_id"]) not in emb_by_rid:
                emb_by_rid[str(t["response_id"])] = t["embedding"]

    clusters: list[dict] = []

    # ── Bootstrap path ────────────────────────────────────────────────────────
    if is_bootstrap or not has_real_embeddings:
        if has_real_embeddings:
            absa_with_emb = [
                {**item, "embedding": emb_lookup.get((item["response_id"], item["question_id"]))}
                for item in state["absa_results"]
            ]
            raw_clusters = cluster_texts(absa_with_emb, threshold=TOPIC_ASSIGNMENT_THRESHOLD, min_cluster_size=2)
            bootstrap_centroids: list[list[float] | None] = []
            for i, raw in enumerate(raw_clusters):
                clusters.append(_make_cluster_from_items(
                    i + 1, raw["texts"],
                    total_size=raw["size"],
                    is_new_topic=False,  # node_topics will set is_new via LLM
                    centroid=raw.get("centroid"),  # stored for node_topics to insert
                ))
                bootstrap_centroids.append(raw.get("centroid"))
            # Any response that didn't form a cluster of ≥2 gets grouped by ABSA aspect
            # so every response surfaces as a topic — no silent drops.
            extra, extra_cent = _group_unclustered_by_aspect(
                raw_clusters, absa_with_emb, start_idx=len(clusters), is_new_topic=False,
            )
            clusters.extend(extra)
            bootstrap_centroids.extend(extra_cent)
        else:
            # No embeddings — aspect heuristic fallback (all aspects, even singletons)
            from collections import defaultdict as _dd
            aspect_groups: dict[str, list] = _dd(list)
            for item in state["absa_results"]:
                aspect_groups[item.get("aspect") or "general feedback"].append(item)
            bootstrap_centroids = []
            for aspect, items in sorted(aspect_groups.items(), key=lambda x: -len(x[1])):
                clusters.append(_make_cluster_from_items(
                    len(clusters) + 1, items,
                    is_new_topic=False,
                    centroid=None,
                ))
                bootstrap_centroids.append(None)

        await _emit_event(run_id, "node_complete", "cluster", {
            "cluster_count": len(clusters),
            "mode": "bootstrap",
            "used_embeddings": has_real_embeddings,
        })
        return {**state, "clusters": clusters, "bootstrap_centroids": bootstrap_centroids}

    # ── Force-regenerate path ─────────────────────────────────────────────────
    # When the user clicks "Generate Insights" on a survey that already has topic
    # centroids, skip clustering entirely. node_topics will load existing signals
    # directly from survey_topics and pass them straight to narration.
    #
    # Why: new_response_ids=∅ on a fully-processed survey → ANN processes nothing
    # → 0 clusters → all previous topics superseded → 1 insight only.
    # The topics and their signal scores are already in survey_topics from the
    # last run — there is no need to recompute them.
    if state.get("force_regenerate") and not is_bootstrap:
        logger.info("node_cluster_force_regenerate_skip", survey_id=survey_id)
        await _emit_event(run_id, "node_complete", "cluster", {
            "cluster_count": 0, "mode": "force_regenerate_skip",
        })
        return {**state, "clusters": [], "bootstrap_centroids": []}

    # ── Incremental path ──────────────────────────────────────────────────────
    # Only process responses that haven't been ABSA-enriched yet.
    new_absa = [a for a in state["absa_results"] if str(a["response_id"]) in new_response_ids]
    # Build lookup: response_id -> list of absa items (for candidate lookup later)
    absa_by_rid: dict[str, list[dict]] = {}
    for a in state["absa_results"]:
        absa_by_rid.setdefault(str(a["response_id"]), []).append(a)

    topic_assignments: dict[str, list[dict]] = {}  # topic_name → absa items

    try:
        async with db._pool_conn().connection() as conn:
            embeddings_by_rid: dict[str, list[float]] = {}
            for item in new_absa:
                rid = str(item["response_id"])
                embedding = emb_by_rid.get(rid)
                if embedding:
                    embeddings_by_rid[rid] = embedding

            # Batch ANN: one centroid fetch + Python cosine sim for all responses
            assignments, unassigned_rids = await topic_registry.assign_batch_to_nearest(
                embeddings_by_rid, survey_id, conn
            )

            topic_emb_groups: dict[str, list[list[float]]] = {}
            for rid, tname in assignments.items():
                items = absa_by_rid.get(rid)
                if items:
                    topic_assignments.setdefault(tname, []).append(items[0])
                if rid in embeddings_by_rid:
                    topic_emb_groups.setdefault(tname, []).append(embeddings_by_rid[rid])

            # Batch Welford: one SELECT FOR UPDATE + executemany UPDATE
            await topic_registry.update_centroids_welford_batch(survey_id, topic_emb_groups, conn)

            cand_pairs = [
                (rid, embeddings_by_rid[rid])
                for rid in unassigned_rids
                if rid in embeddings_by_rid
            ]
            await topic_registry.add_candidates_batch(survey_id, org_id, cand_pairs, conn)

            # Adaptive flush threshold: at least 5, or 3% of total survey responses
            total_responses = len(state.get("responses", []))
            flush_threshold = max(5, int(total_responses * 0.03))
            candidate_count = await topic_registry.get_candidate_count(survey_id, conn)

            new_topic_clusters: list[dict] = []
            if candidate_count >= flush_threshold:
                candidates = await topic_registry.flush_candidates(survey_id, conn)
                logger.info(
                    "node_cluster_flush_candidates",
                    survey_id=survey_id,
                    candidate_count=len(candidates),
                    flush_threshold=flush_threshold,
                )
                if candidates:
                    # Build absa-style items for each candidate using stored ABSA results
                    cand_texts: list[dict] = []
                    for c in candidates:
                        rid = str(c["response_id"])
                        emb = c["embedding"]
                        for a in absa_by_rid.get(rid, []):
                            cand_texts.append({**a, "embedding": emb})
                    if cand_texts:
                        raw_new = cluster_texts(cand_texts, threshold=TOPIC_ASSIGNMENT_THRESHOLD, min_cluster_size=2)
                        for i, raw in enumerate(raw_new):
                            new_topic_clusters.append(_make_cluster_from_items(
                                len(topic_assignments) + i + 1,
                                raw["texts"],
                                total_size=raw["size"],
                                is_new_topic=True,
                                centroid=raw.get("centroid"),
                            ))
                        # Candidates that didn't pair up still deserve a topic — group by aspect.
                        extra, _ = _group_unclustered_by_aspect(
                            raw_new, cand_texts,
                            start_idx=len(topic_assignments) + len(raw_new),
                            is_new_topic=True,
                        )
                        new_topic_clusters.extend(extra)

            await conn.commit()

        # Fetch total response_count per topic from centroid registry for correct trust scores
        centroid_counts: dict[str, int] = {}
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT topic_name, response_count FROM survey_topic_centroids WHERE survey_id = %s",
                    (survey_id,),
                )
                for row in await cur.fetchall():
                    centroid_counts[row[0]] = row[1]

    except Exception as exc:
        logger.error(
            "node_cluster_incremental_failed",
            survey_id=survey_id, error=str(exc), traceback=traceback.format_exc(),
        )
        # Fall back to bootstrap clustering so the run doesn't fail completely
        logger.warning("node_cluster_fallback_to_bootstrap", survey_id=survey_id)
        absa_with_emb = [
            {**item, "embedding": emb_lookup.get((item["response_id"], item["question_id"]))}
            for item in state["absa_results"]
        ]
        raw_clusters = cluster_texts(absa_with_emb, threshold=TOPIC_ASSIGNMENT_THRESHOLD, min_cluster_size=2)
        bootstrap_centroids = []
        for i, raw in enumerate(raw_clusters):
            clusters.append(_make_cluster_from_items(i + 1, raw["texts"], centroid=raw.get("centroid")))
            bootstrap_centroids.append(raw.get("centroid"))
        extra, extra_cent = _group_unclustered_by_aspect(
            raw_clusters, absa_with_emb, start_idx=len(clusters), is_new_topic=False,
        )
        clusters.extend(extra)
        bootstrap_centroids.extend(extra_cent)
        await _emit_event(run_id, "node_complete", "cluster", {
            "cluster_count": len(clusters), "mode": "fallback_bootstrap",
        })
        return {**state, "clusters": clusters, "bootstrap_centroids": bootstrap_centroids, "is_bootstrap": True}

    # Build cluster objects for existing topics (sorted by total size descending)
    existing_clusters: list[dict] = []
    for topic_name, items in topic_assignments.items():
        if not items:
            continue
        existing_clusters.append(_make_cluster_from_items(
            len(existing_clusters) + 1,
            items,
            total_size=centroid_counts.get(topic_name, len(items)),
            canonical_name=topic_name,
            is_new_topic=False,
            centroid=None,  # centroid already in DB, no need to re-insert
        ))

    existing_clusters.sort(key=lambda c: c["size"], reverse=True)
    clusters = existing_clusters + new_topic_clusters

    assigned_count  = sum(len(v) for v in topic_assignments.values())
    candidate_count = len(cand_pairs)

    logger.info(
        "node_cluster_incremental",
        survey_id=survey_id,
        assigned=assigned_count,
        candidates_added=candidate_count,
        new_topic_clusters=len(new_topic_clusters),
        existing_topic_clusters=len(existing_clusters),
    )
    await _emit_event(run_id, "node_complete", "cluster", {
        "cluster_count":        len(clusters),
        "mode":                 "incremental",
        "assigned_to_existing": assigned_count,
        "candidates_buffered":  candidate_count,
        "new_topics_found":     len(new_topic_clusters),
    })
    return {**state, "clusters": clusters}


# ── Node: topics ──────────────────────────────────────────────────────────────

def _cluster_to_topic_item(cluster: dict):
    """Create a TopicItem for an existing topic cluster without calling the LLM.

    Used in incremental mode when a cluster maps to an already-named topic so we
    can upsert its updated signals without spending an LLM token.
    """
    from crystalos.tools.topics import TopicItem
    name = cluster.get("canonical_name") or cluster.get("aspect") or "General"
    texts = cluster.get("texts", [])
    all_text_strs = [t["text"] for t in texts if t.get("text")]
    from crystalos.tools.metrics import compute_effort_score as _effort
    return TopicItem(
        name=name,
        parent_category=None,
        aliases=[],
        is_new=False,
        summary=f"Ongoing feedback about {name}.",
        volume=cluster.get("size", len(texts)),
        sentiment_score=float(cluster.get("avg_sentiment_score") or 0.0),
        dominant_emotion=cluster.get("dominant_emotion") or "neutral",
        effort_score=_effort(all_text_strs) if all_text_strs else 4.0,
    )


async def node_topics(state: dict) -> dict:
    """Discover canonical topics from clusters.

    Bootstrap / force-regenerate: calls discover_topics() LLM for all clusters,
    then seeds the centroid registry.

    Incremental: calls discover_topics() ONLY for clusters marked _new_topic=True
    (i.e., those that emerged from flushing the candidate buffer). For all other
    clusters the canonical name is already known from the centroid registry and
    a TopicItem is constructed locally — zero LLM calls for stable topics.

    In both modes:
    - Upserts survey_topics with fresh signal breakdown
    - Links centroid rows to their survey_topics.id
    - Writes ai_topics back to new/topic-less responses
    - Upserts topic_windows for health label tracking
    """
    survey_id = state["survey_id"]
    org_id    = state["org_id"]
    run_id    = state["run_id"]
    clusters  = state["clusters"]
    is_bootstrap = state.get("is_bootstrap", True)

    await _update_heartbeat(run_id)
    if not state.get("has_open_text", True):
        logger.info("node_topics_skipped_no_text_survey", survey_id=state.get("survey_id"))
        return {**state, "topics": [], "drivers": []}
    # ── Force-regenerate: load existing signals from DB, skip all computation ───
    # Topics and their XM signals are already persisted in survey_topics from the
    # previous run. Load them directly so narration can re-write headlines and the
    # full report without re-clustering, re-naming, or recomputing any scores.
    # Condition: force_regenerate=True on an already-bootstrapped survey (centroids exist).
    # Derived entirely from InsightState fields — no extra flag needed.
    # node_cluster returned clusters=[] in this case; we load signals from survey_topics instead.
    if state.get("force_regenerate") and not state.get("is_bootstrap") and not clusters:
        topic_signals: dict[str, dict] = {}
        try:
            async with db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """SELECT name, volume, sentiment_score, dominant_emotion,
                                  avg_effort_score, trending, urgency_score, nps_avg,
                                  positive_pct, negative_pct, neutral_pct,
                                  emotion_distribution, top_verbatims,
                                  net_sentiment, nps_impact, promoter_pct,
                                  detractor_pct, passive_pct, driver_score,
                                  avg_csat, csat_impact, confidence_level
                           FROM survey_topics
                           WHERE survey_id = %s AND org_id = %s
                             AND time_window = 'all_time'
                           ORDER BY volume DESC NULLS LAST""",
                        (survey_id, org_id),
                    )
                    rows = await cur.fetchall()
                    cols = [d[0] for d in cur.description]
                    for row in rows:
                        r        = dict(zip(cols, row))
                        tname    = r.get("name")
                        if not tname:
                            continue
                        vol  = int(r.get("volume") or 0)
                        sent = float(r.get("sentiment_score") or 0.0)
                        topic_signals[tname] = {
                            "response_count":        vol,
                            "response_pct":          0.0,
                            "confidence_level":      r.get("confidence_level") or (
                                "high" if vol >= 10 else "medium" if vol >= 3 else "low"
                            ),
                            "avg_sentiment_score":   sent,
                            "sentiment_score":       sent,   # backward compat
                            "net_sentiment":         float(r.get("net_sentiment") or 0.0),
                            "sentiment_positive_pct": float(r.get("positive_pct") or 0.0),
                            "sentiment_negative_pct": float(r.get("negative_pct") or 0.0),
                            "sentiment_neutral_pct":  float(r.get("neutral_pct") or 0.0),
                            "dominant_emotion":       r.get("dominant_emotion") or "neutral",
                            "emotion_distribution":   r.get("emotion_distribution") or {},
                            "urgency_score":          float(r.get("urgency_score") or 0.0),
                            "avg_effort_score":       float(r.get("avg_effort_score") or 4.0),
                            "effort_score":           float(r.get("avg_effort_score") or 4.0),
                            "volume":                 vol,   # backward compat
                            "avg_nps_response":       float(r.get("nps_avg") or 0.0),
                            "nps_impact":             r.get("nps_impact"),
                            "promoter_pct":           float(r.get("promoter_pct") or 0.0),
                            "detractor_pct":          float(r.get("detractor_pct") or 0.0),
                            "passive_pct":            float(r.get("passive_pct") or 0.0),
                            "driver_score":           r.get("driver_score"),
                            "avg_csat":               r.get("avg_csat"),
                            "csat_impact":            r.get("csat_impact"),
                            "top_verbatims":          r.get("top_verbatims") or [],
                            "trending":               r.get("trending") or "stable",
                        }
        except Exception as exc:
            logger.warning("node_topics_force_regen_load_failed", error=str(exc))

        n = len(topic_signals)
        # Build synthetic cluster stubs so node_narrate can generate per-topic
        # headline insights exactly as it always does — it reads `clusters`, not
        # `topic_signals`. Each stub carries just enough fields:
        #   canonical_name, size, dominant_sentiment, dominant_emotion, texts
        # `texts` is populated from top_verbatims so sample_quotes + citation_ids work.
        synthetic_clusters: list[dict] = []
        for idx, (tname, sig) in enumerate(
            sorted(topic_signals.items(), key=lambda kv: kv[1].get("response_count", 0), reverse=True)
        ):
            score    = float(sig.get("avg_sentiment_score") or 0.0)
            dom_sent = "negative" if score < -0.05 else ("positive" if score > 0.05 else "neutral")
            verbatims = sig.get("top_verbatims") or []
            texts = [
                {
                    "response_id":  str(v.get("response_id", "")),
                    "text":         str(v.get("text", ""))[:300],
                    "sentiment":    v.get("sentiment", dom_sent),
                    "score":        float(v.get("score", score)),
                    "emotion":      v.get("emotion") or sig.get("dominant_emotion") or "neutral",
                    "effort_score": float(sig.get("avg_effort_score") or 4.0),
                    "aspect":       tname,
                }
                for v in verbatims[:3]
                if isinstance(v, dict)
            ]
            synthetic_clusters.append({
                "id":                f"cluster_{idx + 1}",
                "aspect":            tname,
                "canonical_name":    tname,
                "size":              int(sig.get("response_count") or 0),
                "dominant_sentiment": dom_sent,
                "dominant_emotion":  sig.get("dominant_emotion") or "neutral",
                "avg_sentiment_score": score,
                "texts":             texts,
                "_new_topic":        False,
                "_force_regen":      True,
            })

        n = len(synthetic_clusters)
        logger.info(
            "node_topics_force_regen_from_db",
            survey_id=survey_id,
            topic_count=n,
        )
        await _emit_event(run_id, "node_complete", "topics", {
            "topic_count": n, "mode": "force_regenerate_from_db",
        })
        return {
            **state,
            "topics":          [],
            "topic_signals":   topic_signals,
            "clusters":        synthetic_clusters,   # consumed by node_narrate for topic headlines
        }

    if not clusters:
        return {**state, "topics": []}

    # Guard: skip when there aren't enough distinct clusters for meaningful topics
    total_cluster_size = sum(c.get("size", 0) for c in clusters)
    if len(clusters) < 2 or total_cluster_size < 3:
        logger.info(
            "node_topics_skipped_insufficient_clusters",
            cluster_count=len(clusters),
            total_cluster_size=total_cluster_size,
        )
        await _emit_event(run_id, "node_complete", "topics", {
            "topic_count": 0, "skipped": "insufficient_clusters",
        })
        return {**state, "topics": []}

    # Fetch existing topic names for new-topic detection and LLM guidance
    previous_names: list[str] = []
    try:
        async with db._pool_conn().connection() as conn:
            previous_names = await get_previous_topic_names(survey_id, conn)
    except Exception as exc:
        logger.warning("node_topics_fetch_previous_failed", error=str(exc))

    # Inject specialist canonical topics as seed hints for the LLM
    if state.get("selected_specialists"):
        registry = get_registry()
        primary_id = state["selected_specialists"][0]
        primary = registry.get(primary_id)
        if primary:
            specialist_seeds = primary.canonical_topics()
            seed_names = [t["name"] for t in specialist_seeds[:15]]
            if seed_names:
                hint = (
                    f"[PREFERRED TOPIC NAMES FOR THIS INDUSTRY: {', '.join(seed_names)}. "
                    "Use these names when the content matches — invent new topics only when none fit.]"
                )
                previous_names = [hint] + previous_names
                logger.info({
                    "msg":        "node_topics: injected specialist seed hints",
                    "specialist": primary_id,
                    "seed_count": len(seed_names),
                })

    from crystalos.lib.models import get_model as _get_model
    from crystalos.lib import topic_registry
    ctx_window = _get_model("insight_topics").context_window
    _survey    = state.get("survey", {})

    # ── Split clusters by whether LLM naming is needed ────────────────────────
    # new_clusters: came from candidate-buffer flush → need LLM naming
    # existing_clusters: mapped to a known centroid → name already in centroid registry
    new_clusters      = [c for c in clusters if c.get("_new_topic")]
    existing_clusters = [c for c in clusters if not c.get("_new_topic")]

    # ── LLM call: only for new topic clusters ────────────────────────────────
    new_topics: list = []
    if new_clusters or is_bootstrap:
        # In bootstrap mode all clusters are "new" — pass everything to the LLM.
        llm_targets = clusters if is_bootstrap else new_clusters
        new_topics = await discover_topics(
            llm_targets, previous_names, call_agent,
            context_window=ctx_window,
            survey_title=(_survey.get("title") or "").strip(),
            survey_intent=(_survey.get("intent") or "").strip(),
        )
        llm_calls = len(llm_targets)
    else:
        llm_calls = 0

    # ── Build TopicItem list for existing clusters (no LLM) ───────────────────
    existing_topic_items = [_cluster_to_topic_item(c) for c in existing_clusters]

    # ── Align topic names back to clusters ────────────────────────────────────
    # Bootstrap: new_topics covers all clusters (same ordering)
    # Incremental: existing_clusters have canonical_name set; new_clusters aligned to new_topics
    enriched_clusters: list[dict] = []

    if is_bootstrap:
        aspect_to_topic = {t.name.lower(): t.name for t in new_topics}
        for i, cluster in enumerate(clusters):
            if i < len(new_topics):
                canonical = new_topics[i].name
            else:
                raw_aspect = (cluster.get("aspect") or "").lower()
                canonical = aspect_to_topic.get(raw_aspect, cluster.get("aspect") or "general")
            enriched_clusters.append({**cluster, "canonical_name": canonical})
        all_topics = new_topics
    else:
        # Existing clusters: canonical_name already set by node_cluster
        for cluster in existing_clusters:
            enriched_clusters.append(cluster)

        # New clusters: align to new_topics by position
        for i, cluster in enumerate(new_clusters):
            if i < len(new_topics):
                canonical = new_topics[i].name
            else:
                canonical = cluster.get("aspect") or "New Topic"
            enriched_clusters.append({**cluster, "canonical_name": canonical})

        all_topics = existing_topic_items + new_topics

    await _emit_event(run_id, "node_complete", "topics", {
        "topic_count":      len(all_topics),
        "new_topics":       sum(1 for t in all_topics if getattr(t, "is_new", False)),
        "llm_calls_made":   llm_calls,
        "llm_calls_skipped": len(existing_clusters),
    })

    # ── Compute per-topic XM signal fingerprint (zero LLM cost) ──────────────
    all_responses = state.get("responses", [])
    _metrics      = state.get("metrics", {})
    survey_metrics = {
        "nps_avg":         _metrics.get("nps", {}).get("score"),
        "csat_avg":        _metrics.get("csat", {}).get("score"),
        "total_responses": len(all_responses),
    }
    topic_signals: dict[str, dict] = {}
    for cluster in enriched_clusters:
        topic_name = cluster.get("canonical_name")
        if topic_name:
            topic_signals[topic_name] = compute_full_topic_signals(cluster, all_responses, survey_metrics)

    # Post-pass: compute composite urgency score [0, 10].
    # Formula:
    #   urgency = negativity × 5.0 × √(volume_share × 100) × (effort/7) × trend_mult
    #
    # Key design decisions vs previous version:
    # 1. negativity = max(0, -sentiment) — ONLY negative sentiment drives urgency.
    #    Previously used abs(sentiment), which wrongly flagged highly positive topics
    #    (sentiment=0.8) as urgent as highly negative ones (sentiment=-0.8).
    # 2. volume_share = vol / total_responses — fraction of ALL survey responses.
    #    Previously divided by max_volume (most popular topic), which made urgency
    #    depend on what other topics existed in the same run (non-deterministic).
    # 3. trend_mult only amplifies NEGATIVE trending topics, not positive ones.
    import math as _math
    _total_for_urgency = max(1, len(all_responses))

    # Look up prior trending for trend_multiplier (best-effort — default to "stable")
    trending_lookup: dict[str, str] = {}
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT name, trending FROM survey_topics WHERE survey_id = %s AND time_window = 'all_time'",
                    (survey_id,),
                )
                for row in await cur.fetchall():
                    trending_lookup[row[0]] = row[1] or "stable"
    except Exception:
        pass

    for tname, sig in topic_signals.items():
        vol           = sig.get("response_count", 0)
        avg_sentiment = sig.get("avg_sentiment_score", 0.0)
        avg_effort    = sig.get("avg_effort_score", 4.0) or 4.0
        trending      = trending_lookup.get(tname, "stable") or "stable"

        # Negativity: only negative topics are urgent (positive = strength, not urgent)
        negativity    = max(0.0, -avg_sentiment)

        # Trend multiplier: only amplify negative topics that are worsening
        if trending == "up" and avg_sentiment < 0:
            trend_mult = 1.5   # getting worse and growing — high urgency
        elif trending == "down" and avg_sentiment < 0:
            trend_mult = 0.85  # negative but shrinking — slightly reduced urgency
        else:
            trend_mult = 1.0

        # Volume share: fraction of all survey responses (stable cross-run reference)
        volume_share = vol / _total_for_urgency

        sig["urgency_score"] = round(min(10.0, (
            negativity
            * 5.0
            * _math.sqrt(volume_share * 100)
            * (avg_effort / 7.0)
            * trend_mult
        )), 2)

    # ── Upsert topics with signal breakdown ───────────────────────────────────
    topic_db_ids: dict[str, str] = {}
    try:
        async with db._pool_conn().connection() as conn:
            topic_db_ids = await upsert_survey_topics(
                all_topics, survey_id, org_id, run_id, "all_time", conn,
                topic_signals=topic_signals,
            )
            await conn.commit()
    except Exception as exc:
        logger.error("node_topics_signal_upsert_failed", error=str(exc), traceback=traceback.format_exc())

    # ── Write extended XM signals to survey_topics (denormalized fast reads) ──
    if topic_db_ids:
        try:
            async with db._pool_conn().connection() as conn:
                for tname, tid in topic_db_ids.items():
                    sig = topic_signals.get(tname, {})
                    if sig:
                        await topic_registry.upsert_survey_topic_signals(tid, sig, conn)
                await conn.commit()
        except Exception as exc:
            logger.warning("node_topics_extended_signals_failed", error=str(exc), traceback=traceback.format_exc())

    # ── Seed / link centroid registry ─────────────────────────────────────────
    try:
        async with db._pool_conn().connection() as conn:
            if is_bootstrap:
                # Bootstrap: insert one centroid per cluster using stored centroid vectors
                bootstrap_centroids = state.get("bootstrap_centroids", [])
                for i, cluster in enumerate(enriched_clusters):
                    topic_name = cluster.get("canonical_name")
                    if not topic_name:
                        continue
                    centroid_vec = bootstrap_centroids[i] if i < len(bootstrap_centroids) else None
                    if centroid_vec:
                        topic_id = topic_db_ids.get(topic_name)
                        await topic_registry.insert_centroid(
                            survey_id, org_id, topic_name, centroid_vec,
                            cluster.get("size", 0), conn, topic_id=topic_id,
                        )
                logger.info("node_topics_centroids_seeded", survey_id=survey_id, count=len(enriched_clusters))
            else:
                # Incremental: link any existing centroids that don't have topic_id yet
                # and insert centroids for newly named topics (_new_topic clusters)
                for i, cluster in enumerate(new_clusters):
                    topic_name = cluster.get("canonical_name") or (
                        new_topics[i].name if i < len(new_topics) else None
                    )
                    if not topic_name:
                        continue
                    centroid_vec = cluster.get("_centroid")
                    topic_id = topic_db_ids.get(topic_name)
                    if centroid_vec:
                        await topic_registry.insert_centroid(
                            survey_id, org_id, topic_name, centroid_vec,
                            cluster.get("size", 0), conn, topic_id=topic_id,
                        )
                    elif topic_id:
                        # Link existing centroid to topic_id
                        await topic_registry.update_centroid_topic_id(survey_id, topic_name, topic_id, conn)
                # Also patch topic_ids for existing centroids that were missing them
                for cluster in existing_clusters:
                    tname = cluster.get("canonical_name")
                    tid   = topic_db_ids.get(tname) if tname else None
                    if tname and tid:
                        await topic_registry.update_centroid_topic_id(survey_id, tname, tid, conn)
            await conn.commit()
    except Exception as exc:
        logger.error("node_topics_centroid_seed_failed", error=str(exc), traceback=traceback.format_exc())

    # ── Build topic hierarchy ─────────────────────────────────────────────────
    try:
        async with db._pool_conn().connection() as conn:
            await build_topic_hierarchy(
                all_topics, topic_db_ids, survey_id, org_id, run_id, "all_time", conn,
            )
    except Exception as exc:
        logger.error("node_topics_hierarchy_failed", error=str(exc), traceback=traceback.format_exc())

    # ── Write ai_topics back — only for new or topic-less responses ───────────
    try:
        from collections import defaultdict as _dd2
        new_response_ids: set[str] = state.get("new_response_ids", set())
        topics_already_written: set[str] = {
            str(r["id"]) for r in all_responses
            if r.get("ai_topics") and r.get("ai_enriched_at")
            and str(r["id"]) not in new_response_ids
        }

        resp_topics: dict[str, list[str]] = _dd2(list)
        for cluster in enriched_clusters:
            canonical = cluster.get("canonical_name") or ""
            for item in cluster.get("texts", []):
                rid = str(item["response_id"])
                if rid not in topics_already_written and canonical:
                    if canonical not in resp_topics[rid]:
                        resp_topics[rid].append(canonical)

        if resp_topics:
            updates = [(json.dumps(tlist), rid) for rid, tlist in resp_topics.items()]
            async with db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    await cur.executemany(
                        "UPDATE responses SET ai_topics=%s, ai_enriched_at=NOW() WHERE id=%s",
                        updates,
                    )
                await conn.commit()
            logger.info(
                "node_topics_writeback",
                response_count=len(updates),
                skipped_already_decorated=len(topics_already_written),
            )
    except Exception as exc:
        logger.error("node_topics_writeback_failed", error=str(exc), traceback=traceback.format_exc())

    # ── Upsert topic health windows (full XM signals per window) ─────────────
    try:
        async with db._pool_conn().connection() as conn:
            for cluster in enriched_clusters:
                tname = cluster.get("canonical_name")
                tid   = topic_db_ids.get(tname) if tname else None
                if not tid:
                    continue
                sig = topic_signals.get(tname, {})
                await topic_registry.upsert_topic_window(survey_id, org_id, tid, sig, conn, topic_name=tname)
            await conn.commit()
    except Exception as exc:
        logger.warning("node_topics_windows_failed", error=str(exc), traceback=traceback.format_exc())

    return {
        **state,
        "topics":        [t.model_dump() for t in all_topics],
        "clusters":      enriched_clusters,
        "topic_signals": topic_signals,   # name → full_topic_signals; consumed by node_narrate + node_report_agent
    }


# ── Node: narrate (expert domain-specific agents) ────────────────────────────

async def _narrate_score_only(state: dict) -> list[dict]:
    """Generate score-only insights for surveys without open-text questions."""
    metrics = state.get("metrics", {})
    total_responses = metrics.get("total_responses", 0)
    insights_out = []

    system = (
        "You are a CX analyst. This survey has no open-text questions. "
        "Summarise the score data in a single insight. Do not mention themes, topics, or verbatims. "
        'Return exactly one JSON object with two keys: "headline" (plain-English summary, max 120 chars) '
        'and "narrative" (2-3 sentences expanding on the scores, max 600 chars). No markdown, no arrays.'
    )

    # Build a quick metrics summary
    lines = [f"Total responses: {total_responses}"]
    nps = metrics.get("nps", {})
    if nps.get("score") is not None:
        lines.append(f"NPS: {nps['score']} (n={nps.get('n', total_responses)})")
        if nps.get("promoters") is not None:
            lines.append(f"  Promoters: {nps['promoters']}%, Passives: {nps.get('passives',0)}%, Detractors: {nps.get('detractors',0)}%")
    csat = metrics.get("csat", {})
    if csat.get("score") is not None:
        lines.append(f"CSAT: {csat['score']}/5 (n={csat.get('n', total_responses)})")
    ces = metrics.get("ces", {})
    if ces.get("score") is not None:
        lines.append(f"CES: {ces['score']} (n={ces.get('n', total_responses)})")
    completion = metrics.get("completion", {})
    if completion.get("rate") is not None:
        lines.append(f"Completion rate: {completion['rate']}%")

    user_content = "\n".join(lines) + "\n\nWrite a single combined insight summarising all scores above."

    try:
        from crystalos.lib.openrouter import call_agent
        from crystalos.schemas.insight import NarrateInsightOutput
        output, _ = await call_agent(
            agent_name="insight_narrate",
            system=system,
            user=user_content,
            output_schema=NarrateInsightOutput,
        )
        survey_id = state.get("survey_id", "")
        org_id    = state.get("org_id", "")
        trust_score, trust_json = _build_trust(
            n=total_responses, mentions=total_responses, total=total_responses
        )
        ins = {
            "layer": "descriptive",
            "category": "metric.score_summary",
            "headline":  output.headline,
            "narrative": output.narrative,
            "trust_score": trust_score,
            "trust_json":  trust_json,
            "citations_json": [],
            "priority": 0.75,
        }
        if hasattr(output, "metric_json") and output.metric_json:
            ins["metric_json"] = output.metric_json
        insights_out.append(ins)
    except Exception as exc:
        logger.warning("narrate_score_only_failed", error=str(exc))

    return insights_out


def _parse_json_field(val: Any) -> Any:
    """Safely parse a JSONB field that may already be a dict/list or a JSON string."""
    if isinstance(val, (dict, list)):
        return val
    if isinstance(val, str):
        try:
            return json.loads(val)
        except Exception:
            pass
    return val


def _reuse_existing_insight(row: dict) -> dict:
    """Convert a DB insight row back to the in-memory insights dict format."""
    return {
        "layer":              row.get("layer", ""),
        "category":           row.get("category", ""),
        "headline":           row.get("headline", ""),
        "narrative":          row.get("narrative", ""),
        "metric_json":        _parse_json_field(row.get("metric_json")) or {},
        "trust_score":        row.get("trust_score") or 50,
        "trust_json":         _parse_json_field(row.get("trust_json")) or {},
        "citations_json":     _parse_json_field(row.get("citations_json")) or [],
        "recommended_action": _parse_json_field(row.get("recommended_action")),
        "priority":           float(row.get("priority") or 0.7),
        "audit_json":         _parse_json_field(row.get("audit_json")) or {},
        "_reused":            True,
    }


def _map_skill_insights_to_records(skill_output: dict, state: dict) -> list[dict]:
    """Map insight-narrator skill output to the InsightRecord format expected by node_publish.

    Translates skill's key_findings[] and recommended_actions[] into the category/layer/
    headline/narrative/trust_score dicts that _publish_one() writes to the DB.

    Field formats must match the AgenticInsight TypeScript interface in the frontend:
      - recommended_action: {type, label, target?, priority?, time_horizon?} | null
      - trust_json: {statistical, coverage, consistency, grounding (int), sample_size, below_minimum_sample}
    """
    metrics     = state.get("metrics", {})
    total_resp  = int(metrics.get("total_responses", 0))
    confidence  = float(skill_output.get("confidence", 0.75))
    base_trust  = min(95, max(40, int(confidence * 100)))
    stat_score  = _trust_statistical(total_resp)
    records: list[dict] = []

    def _base_trust_json(verifier_pass: bool = True) -> dict:
        """Build a trust_json dict matching InsightTrust interface (all numeric fields)."""
        return {
            "statistical":          stat_score,
            "coverage":             70,
            "consistency":          70,
            "grounding":            _trust_grounding(verifier_pass),  # always int (100 or 60)
            "sample_size":          total_resp,
            "below_minimum_sample": total_resp < 30,
            "verifier_pass":        verifier_pass,
        }

    # key_findings → descriptive / diagnostic / predictive insights
    for finding in skill_output.get("key_findings", []):
        layer = finding.get("layer", "descriptive")
        sentiment_str = finding.get("sentiment", "neutral")
        sent_score = {"positive": 0.6, "negative": -0.6, "neutral": 0.0, "mixed": -0.1}.get(sentiment_str, 0.0)
        verbatim = finding.get("supporting_verbatim", "")
        records.append({
            "layer": layer,
            "category": f"voice.{layer}",
            "headline": finding.get("finding", "")[:120],
            "narrative": finding.get("finding", ""),
            "recommended_action": None,   # None → NULL in DB → frontend: no action section
            "metric_json": {
                "volume_pct": finding.get("volume_pct", 0.0),
                "confidence": finding.get("confidence", "medium"),
                "sentiment_score": sent_score,
                "source": "skill:insight-narrator",
            },
            "citations_json": [{"quote": verbatim, "source": "verbatim"}] if verbatim else [],
            "trust_score": base_trust,
            "trust_json": _base_trust_json(verifier_pass=True),
            "priority": 0,
        })

    # recommended_actions → prescriptive insights
    # recommended_action must be InsightRecommendedAction: {type, label, target?, priority?, time_horizon?}
    _priority_order = {"critical": 3, "high": 2, "medium": 1, "low": 0}
    for i, action in enumerate(skill_output.get("recommended_actions", [])):
        if isinstance(action, dict):
            action_text   = action.get("action", "")
            priority_str  = action.get("priority", "medium")
            time_horizon  = action.get("time_horizon", "medium_term")
            ice_impact    = action.get("ice_impact", 5)
            ice_ease      = action.get("ice_ease", 5)
        else:
            action_text   = str(action)
            priority_str  = "medium"
            time_horizon  = "medium_term"
            ice_impact    = 5
            ice_ease      = 5

        records.append({
            "layer": "prescriptive",
            "category": "voice.recommendation",
            "headline": action_text[:120],
            "narrative": action_text,
            # Structured dict matching InsightRecommendedAction TS interface
            "recommended_action": {
                "type": time_horizon,
                "label": action_text[:120],
                "target": "team",
                "priority": priority_str,
                "time_horizon": time_horizon,
                "estimated_impact": f"ICE score: impact={ice_impact}/10, ease={ice_ease}/10",
            },
            "metric_json": {
                "priority": priority_str,
                "time_horizon": time_horizon,
                "source": "skill:insight-narrator",
                "action_index": i,
            },
            "citations_json": [],
            "trust_score": max(35, base_trust - 5),
            "trust_json": _base_trust_json(verifier_pass=True),
            "priority": _priority_order.get(priority_str, 1),
        })

    return records


# ── Node: delta_compute (Insight Pipeline v2 — Phase 0.5) ─────────────────────

async def node_delta_compute(state: dict) -> dict:
    """Compute delta from the prior checkpoint. Runs BETWEEN topics and narrate.

    Phase 0.5: uses compute_delta() output only (NPS/CSAT/CES + topic name-set
    changes). Uses up to 5 prior checkpoints from state["prior_checkpoints"]
    (resolve_context's already-walked, schema-aware chain — v2-first, legacy
    fallback, correctly reading each row's blob ref regardless of which table
    it came from; fixed 2026-07-04, see _checkpoint_blob_ref), reads the
    latest prior blob, computes current metrics from state + parent metrics
    from the blob, sets meaningful_delta, and builds scalar
    prior_checkpoint_summaries (oldest first). On bootstrap or any load
    failure it falls back to the bootstrap path (delta_from_prior=None,
    meaningful_delta=True) — never crashes the pipeline.

    Phase 2 extension: walk_parent_chain + compute_topic_lifecycle (share-weighted).
    """
    from crystalos.tools.delta import (
        compute_delta,
        extract_metrics_from_state,
        extract_metrics_from_blob,
        build_current_topic_name_set,
        evaluate_meaningful_delta,
    )

    survey_id = state["survey_id"]
    org_id    = state["org_id"]
    run_id    = state["run_id"]
    settings  = state.get("survey_settings", {})  # Phase 2 loads this; {} in Phase 0.5
    is_bootstrap = state.get("is_bootstrap", False)
    await _update_heartbeat(run_id)

    if is_bootstrap:
        return {
            **state,
            "delta_from_prior":           None,
            "meaningful_delta":           True,   # bootstrap always writes
            "prior_checkpoint_summaries": [],
            "ai_trigger_baseline_negative_pct": None,
        }

    # Fixed 2026-07-04: this previously ran its OWN independent query against
    # ONLY the legacy survey_insight_checkpoints table — never
    # insight_checkpoints_v2 — despite this docstring claiming "Phase 2
    # replaces this with walk_parent_chain". That replacement was never
    # actually done. Found during a deep audit prompted by the
    # parent_checkpoint_id/is_bootstrap/lineage fixes above: if
    # STOP_LEGACY_CHECKPOINT_WRITE is ever enabled (the documented next step
    # once v2 migration is complete), this would silently stop finding ANY
    # prior data — every automated run would report "no meaningful delta,
    # treat as fresh" instead of a real trend comparison, with no error
    # anywhere. Now reuses resolve_context's own already-resolved,
    # schema-aware chain (state["prior_checkpoints"]) instead of a second,
    # independent, legacy-only lookup — one canonical source of "what's the
    # prior checkpoint history" for the whole run, not two that can disagree.
    prior_rows: list[dict] = []
    prior_blob: dict | None = None
    try:
        for row in (state.get("prior_checkpoints") or []):
            if not isinstance(row, dict):
                continue
            blob_ref = _checkpoint_blob_ref(row)
            if not blob_ref:
                continue
            prior_rows.append({**row, "report_url": blob_ref})
            if len(prior_rows) >= 5:
                break
        if prior_rows:
            from crystalos.lib.checkpoint_store import read_checkpoint_blob
            prior_blob = await read_checkpoint_blob(prior_rows[0]["report_url"])
    except Exception as exc:
        logger.warning("node_delta_compute_load_failed", survey_id=survey_id, error=str(exc))

    if not prior_blob:
        # No prior checkpoint blob — treat as bootstrap (cannot compute a delta).
        return {
            **state,
            "delta_from_prior":           None,
            "meaningful_delta":           True,
            "prior_checkpoint_summaries": [],
            "ai_trigger_baseline_negative_pct": None,
        }

    current_metrics = extract_metrics_from_state(state)
    parent_metrics  = extract_metrics_from_blob(prior_blob)

    # Phase 0.5 topic changes: name-set intersection. compute_delta derives
    # emerged/resolved/persisted from the "topics" arrays of {name} on each side, so
    # we attach a normalized {name} list to both the current and parent metric dicts.
    current_topic_names = build_current_topic_name_set(state)
    current_metrics["topics"] = [{"name": n} for n in sorted(current_topic_names)]
    parent_metrics["topics"] = [
        {"name": t.get("name", "")} for t in (prior_blob.get("topics") or []) if t.get("name")
    ]

    # Phase 2: pull N-2 blob (second prior checkpoint) for trend persistence when
    # available, so trend_direction/persistence reflect a 3-point trajectory.
    n2_blob = None
    if len(prior_rows) >= 2:
        try:
            n2_url = prior_rows[1].get("report_url")
            if n2_url:
                from crystalos.lib.checkpoint_store import read_checkpoint_blob as _read2
                n2_blob = await _read2(n2_url)
                n2_blob = extract_metrics_from_blob(n2_blob)
        except Exception:
            n2_blob = None
    delta = compute_delta(current_metrics, parent_metrics, n2_blob)

    # Phase 2: share-weighted topic lifecycle. When the parent blob carries topic
    # volume/volume_share data, replace the name-set topic_changes with the richer
    # emerged/growing/stable/declining/resolved classification + fingerprint_changed.
    try:
        from crystalos.tools.delta import compute_topic_lifecycle
        parent_topics_blob = prior_blob.get("topics") or []
        has_share = any(
            (isinstance(t, dict) and (t.get("volume_share") is not None or t.get("volume") is not None))
            for t in parent_topics_blob
        )
        current_topic_signals = state.get("topic_signals") or {}
        if has_share and current_topic_signals:
            lifecycle = compute_topic_lifecycle(parent_topics_blob, current_topic_signals, settings)
            delta["topic_changes"] = {
                "emerged":   lifecycle["emerged"],
                "resolved":  lifecycle["resolved"],
                "persisted": lifecycle["persisted"],
                "growing":   lifecycle["growing"],
                "declining": lifecycle["declining"],
                "stable":    lifecycle["stable"],
            }
            delta["fingerprint_changed"] = lifecycle["fingerprint_changed"]
    except Exception as exc:
        logger.debug("node_delta_compute_lifecycle_skipped", survey_id=survey_id, error=str(exc))

    meaningful = evaluate_meaningful_delta(delta, settings)
    delta["meaningful_delta"] = meaningful

    prior_checkpoint_summaries = [
        {
            "checkpoint_number": r["checkpoint_number"],
            "created_at":        str(r["created_at"])[:10] if r.get("created_at") else "",
            "nps":               r.get("nps_at_checkpoint"),
        }
        for r in reversed(prior_rows)   # oldest first
    ]

    logger.info(
        "node_delta_compute_done",
        survey_id=survey_id,
        nps_delta=delta.get("nps_delta"),
        meaningful_delta=meaningful,
        topics_emerged=len(delta.get("topic_changes", {}).get("emerged", [])),
        topics_resolved=len(delta.get("topic_changes", {}).get("resolved", [])),
    )

    # Xperiq Actions Wave 3 (AI triggers) — carry the prior blob's negative-
    # sentiment share forward as the sentiment_spike baseline. Additive-only
    # read of a field node_publish started writing this wave
    # (`ai_trigger_negative_pct`); absent on older blobs, so this is None for
    # any survey whose most recent checkpoint predates this wave — the trigger
    # simply doesn't fire until one post-wave checkpoint exists to seed it.
    prior_negative_pct = prior_blob.get("ai_trigger_negative_pct")

    return {
        **state,
        "delta_from_prior":           delta,
        "meaningful_delta":           meaningful,
        "prior_checkpoint_summaries": prior_checkpoint_summaries,
        "ai_trigger_baseline_negative_pct": prior_negative_pct,
    }


# ── DELTA_FACTS narrate-injection helpers (Phase 0.5) ─────────────────────────

def _build_delta_facts_block(delta: dict) -> str:
    """Build the authoritative DELTA_FACTS block prepended to specialist overlays.

    Omits the NPS/CSAT/CES line when that delta is None; omits the emerged/resolved
    lines when empty. Never suppresses the whole block for a missing NPS — other
    fields may still be meaningful. The caller suppresses the block only when delta
    itself is None (bootstrap path).
    """
    nps_line = ""
    if delta.get("nps_delta") is not None:
        nps_line = (
            f"NPS delta: {delta['nps_delta']:+.1f} pts  "
            f"({delta.get('trend_direction', 'stable')}, "
            f"{delta.get('trend_persistence', 'first_occurrence')})\n"
        )
    topic_changes = delta.get("topic_changes", {}) or {}

    def _names(items: list) -> list[str]:
        # Phase 0.5 items are strings; Phase 2 items are {"name": ...} dicts.
        out = []
        for it in (items or []):
            if isinstance(it, dict):
                n = it.get("name")
                if n:
                    out.append(str(n))
            elif it:
                out.append(str(it))
        return out

    emerged  = _names(topic_changes.get("emerged"))
    resolved = _names(topic_changes.get("resolved"))
    return (
        "━━━ DELTA_FACTS (code-computed — authoritative for metric values) ━━━\n"
        + nps_line
        + (f"CSAT delta: {delta['csat_delta']:+.2f}\n" if delta.get("csat_delta") is not None else "")
        + (f"CES delta: {delta['ces_delta']:+.2f}\n" if delta.get("ces_delta") is not None else "")
        + f"New responses: {delta.get('response_count_delta', 0)}\n"
        + (f"Topics emerged: {', '.join(emerged)}\n" if emerged else "")
        + (f"Topics resolved: {', '.join(resolved)}\n" if resolved else "")
        + "\nCITATION RULE: Metric delta claims state DELTA_FACTS values directly "
          "(no verbatim citation); theme/topic claims require a [rXXX] citation; "
          "multi-checkpoint trend claims cite the TRAJECTORY block (no verbatim).\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )


def _build_trajectory_block(summaries: list[dict]) -> str:
    """Build the CHECKPOINT TRAJECTORY block (oldest → newest). Caller appends it
    only when len(summaries) >= 2."""
    traj_lines = "\n".join(
        f"  Checkpoint #{s['checkpoint_number']} ({str(s.get('created_at', ''))[:10]}): "
        f"NPS {s.get('nps', 'N/A')}"
        for s in summaries
    )
    return (
        "━━━ CHECKPOINT TRAJECTORY (oldest → newest) ━━━\n"
        + traj_lines + "\n"
        "Use this to identify multi-checkpoint trends in your narrative.\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )


def _build_baseline_mode_block() -> str:
    """Build the BASELINE_MODE block for the bootstrap / null-delta path."""
    return (
        "━━━ BASELINE_MODE ━━━\n"
        "This is the FIRST checkpoint for this survey. No prior state exists.\n"
        "Narrate as a BASELINE — establish what IS, not what changed.\n"
        "Do NOT use directional language: avoid 'increased', 'decreased', 'dropped', "
        "'grew', 'improved', 'declined'.\n"
        "Describe current NPS, top themes by volume, and sentiment distribution.\n"
        "━━━━━━━━━━━━━━━━━━━━━\n"
    )


async def node_narrate(state: dict) -> dict:
    """Generate headlines + narratives using specialist expert agents in parallel.

    Each insight type is handled by a domain expert with deep knowledge baked into
    its system prompt (benchmarks, frameworks, vocabulary). Expert calls for clusters
    run concurrently via asyncio.gather for minimal latency overhead.

    When USE_SKILL_RUNTIME=true, delegates to the 'insight-narrator' CrystalOS skill.
    Falls back to legacy expert agent path on any skill failure.
    """
    run_id          = state["run_id"]
    await _update_heartbeat(run_id)
    if not state.get("has_open_text", True):
        score_insights = await _narrate_score_only(state)
        await _emit_event(run_id, "node_complete", "narrate", {
            "insight_count": len(score_insights), "score_only": True,
        })
        return {**state, "insights": score_insights, "insights_from_cache": False}

    force_regenerate = state.get("force_regenerate", False)
    new_response_ids = state.get("new_response_ids", set())
    metrics  = state["metrics"]
    clusters = state["clusters"]
    topics   = state.get("topics", [])
    insights: list[dict] = []

    total_responses = metrics.get("total_responses", 0)
    nps_score  = metrics.get("nps", {}).get("score")

    # ── Load insights: TWO separate queries for TWO different purposes ───────────
    #
    # QUERY 1 — Cache check (superseded_at IS NULL):
    #   If nothing changed, return the existing active insights without re-running LLM.
    #
    # QUERY 2 — Prior context from the ANCHOR RUN:
    #   The anchor is the last completed run that processed genuinely new responses
    #   (new_response_count > 0 OR trigger IN ('schedule','stream')).
    #   Manual regenerations with no new data do NOT advance the anchor — they reuse
    #   the same prior context as the run before them.
    #
    #   WHY: if the user clicks "Generate" 5 times with no new responses, using
    #   the most-recently-generated insights as prior would compound synthesis on
    #   synthesis. By anchoring to the last real-data run, every manual regen
    #   draws from the same authentic historical baseline regardless of how many
    #   times the button is clicked.
    survey_id = state["survey_id"]
    org_id    = state["org_id"]

    # ── Query 1: active insights for cache check ──────────────────────────────
    current_insight_rows: list[dict] = []
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT category, layer, headline, narrative, trust_score, trust_json,
                              citations_json, metric_json, recommended_action, priority, audit_json
                       FROM insights
                       WHERE survey_id = %s AND org_id = %s AND superseded_at IS NULL
                       ORDER BY trust_score DESC NULLS LAST, priority DESC NULLS LAST""",
                    (survey_id, org_id),
                )
                rows = await cur.fetchall()
                if rows:
                    cols = [desc[0] for desc in cur.description]
                    current_insight_rows = [dict(zip(cols, r)) for r in rows]
    except Exception as exc:
        logger.warning("node_narrate_load_insights_failed", error=str(exc))

    # Cache hit: return active insights untouched when nothing has changed
    if not force_regenerate and len(new_response_ids) == 0 and current_insight_rows:
        cached_insights = [_reuse_existing_insight(r) for r in current_insight_rows]
        logger.info("node_narrate_cache_hit", insight_count=len(cached_insights), survey_id=survey_id)
        await _emit_event(run_id, "node_complete", "narrate", {
            "insight_count": len(cached_insights), "cache_hit": True,
        })
        return {**state, "insights": cached_insights, "insights_from_cache": True}

    # ── CrystalOS Skill Runtime gate ────────────────────────────────────────────────
    # When USE_SKILL_RUNTIME=true, delegate narration to the 'insight-narrator' skill.
    # On any failure, fall through to the existing expert agent path (safe fallback).
    from crystalos.lib.constants import USE_SKILL_RUNTIME
    if USE_SKILL_RUNTIME:
        try:
            from crystalos.lib.skill_registry import get_registry as _get_skill_registry
            _reg = _get_skill_registry()
            if _reg.is_initialized() and _reg.get_skill_meta("insight-narrator"):
                _skill_input = {
                    "survey_id": survey_id,
                    "survey_type": state.get("survey_type", "custom"),
                    "response_count": metrics.get("total_responses", 0),
                    "topics": [
                        {
                            "label": t.get("name", t.get("label", "")),
                            "sentiment_score": float(t.get("sentiment_score", 0.0)),
                            "volume": int(t.get("volume", 0)),
                            "volume_pct": float(t.get("volume_pct", 0.0)),
                            "sample_verbatims": t.get("sample_verbatims", [])[:3],
                            "trending": t.get("trending"),
                            "urgency_score": float(t.get("urgency_score", 0.5)),
                        }
                        for t in topics[:15]
                    ],
                    "metrics": metrics,
                    "prior_insights": [
                        {"headline": p.get("headline", ""), "layer": p.get("layer", ""), "trust_score": p.get("trust_score", 50)}
                        for p in state.get("prior_insights", [])[:8]
                    ],
                    "survey_title": state.get("survey_title", ""),
                }
                _skill_ctx = {"org_id": org_id, "survey_id": survey_id, "run_id": run_id}
                _skill_result = await _reg.execute("insight-narrator", _skill_input, _skill_ctx)
                if _skill_result.get("eval_passed") and _skill_result.get("output"):
                    _skill_insights = _map_skill_insights_to_records(_skill_result["output"], state)
                    if _skill_insights:
                        logger.info(
                            "node_narrate_skill_runtime",
                            insight_count=len(_skill_insights),
                            eval_score=_skill_result.get("eval_score"),
                            retried=_skill_result.get("retried"),
                        )
                        await _emit_event(run_id, "node_complete", "narrate", {
                            "insight_count": len(_skill_insights),
                            "source": "skill:insight-narrator",
                        })
                        return {**state, "insights": _skill_insights, "insights_from_cache": False}
                logger.info("node_narrate_skill_fallback", reason="skill eval failed or empty output")
        except Exception as _skill_exc:
            logger.warning("node_narrate_skill_error", error=str(_skill_exc))
            # Fall through to legacy path

    # ── DELTA_FACTS injection setup (Phase 0.5) ───────────────────────────────
    # The checkpoint chain (delta_from_prior + prior_checkpoint_summaries) is the
    # single source of historical narrative context. When it is available we SUPPRESS
    # the ESTABLISHED FINDINGS anchor-run query and block so the two history channels
    # do not double-count. On bootstrap / null-delta we narrate in BASELINE_MODE.
    delta_from_prior    = state.get("delta_from_prior")
    ckpt_summaries      = state.get("prior_checkpoint_summaries", []) or []
    is_bootstrap_run    = state.get("is_bootstrap", False)
    suppress_established_findings = is_bootstrap_run or bool(ckpt_summaries) or delta_from_prior is not None

    # ── Query 2: find the anchor run for prior context ────────────────────────
    # The anchor = last completed insight_generation run that had real new data:
    #   • trigger_type IN ('schedule', 'stream') — scheduled/stream runs always process data
    #   • OR new_response_count > 0 — manual run that actually processed new responses
    # Excludes the CURRENT run (id != run_id) and manual regens with 0 new responses.
    # Skipped entirely when the checkpoint chain supplies historical context.
    anchor_run_id: str = ""
    prior_insight_rows: list[dict] = []
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                # Find anchor run
                await cur.execute(
                    """SELECT id FROM agent_runs
                       WHERE survey_id = %s
                         AND org_id    = %s
                         AND status    = 'completed'
                         AND run_type  = 'insight_generation'
                         AND id        != %s
                         AND (
                               trigger_type IN ('schedule', 'stream')
                            OR new_response_count > 0
                         )
                       ORDER BY completed_at DESC
                       LIMIT 1""",
                    (survey_id, org_id, run_id),
                )
                anchor_row = await cur.fetchone()
                if anchor_row:
                    anchor_run_id = str(anchor_row[0])
                    # Load insights published by that anchor run
                    await cur.execute(
                        """SELECT id, category, layer, headline, narrative, trust_score,
                                  trust_json, citations_json, metric_json,
                                  recommended_action, priority, audit_json
                           FROM insights
                           WHERE survey_id = %s
                             AND org_id    = %s
                             AND run_id    = %s
                           ORDER BY trust_score DESC NULLS LAST, priority DESC NULLS LAST""",
                        (survey_id, org_id, anchor_run_id),
                    )
                    arows = await cur.fetchall()
                    if arows:
                        acols = [d[0] for d in cur.description]
                        prior_insight_rows = [dict(zip(acols, r)) for r in arows]
    except Exception as exc:
        logger.warning("node_narrate_anchor_load_failed", error=str(exc))

    # Phase 0.5: when the checkpoint chain supplies historical context, drop any
    # anchor-run rows so ESTABLISHED FINDINGS is fully suppressed below.
    if suppress_established_findings:
        prior_insight_rows = []
        anchor_run_id = ""

    # Fallback: if no anchor found (first run or DB miss), use active insights as prior
    # so the first real report still gets some context from what's been published.
    if not suppress_established_findings and not prior_insight_rows and current_insight_rows:
        prior_insight_rows = current_insight_rows

    logger.info(
        "node_narrate_prior_anchor",
        survey_id=survey_id,
        anchor_run_id=anchor_run_id or "none",
        prior_row_count=len(prior_insight_rows),
        current_new_responses=len(new_response_ids),
        force_regenerate=force_regenerate,
    )

    # ── Select prior context from anchor run insights ─────────────────────────
    # Strategy: prefer actionable layers above trust threshold; fill remaining
    # slots with best-available so LLM always gets meaningful historical context.
    preferred = [
        r for r in prior_insight_rows
        if r.get("layer") in PRIOR_INSIGHT_LAYERS
        and float(r.get("trust_score") or 0) >= PRIOR_INSIGHT_MIN_TRUST
    ][:PRIOR_INSIGHT_MAX_COUNT]

    prior_insights: list[dict] = list(preferred)
    if len(prior_insights) < PRIOR_INSIGHT_MAX_COUNT and prior_insight_rows:
        existing_headlines = {p.get("headline") for p in prior_insights}
        for r in prior_insight_rows:
            if len(prior_insights) >= PRIOR_INSIGHT_MAX_COUNT:
                break
            if r.get("headline") not in existing_headlines:
                prior_insights.append(r)
                existing_headlines.add(r.get("headline"))

    # Build the prior-context block injected into the specialist overlay.
    # Format: layer + trust score + headline + brief narrative snippet.
    # The LLM is told to acknowledge continuity or flag divergence.
    prior_context_block = ""
    if prior_insights:
        lines = []
        for pi in prior_insights:
            trust    = int(float(pi.get("trust_score") or 0))
            layer    = (pi.get("layer") or "").upper()
            headline = pi.get("headline") or ""
            snippet  = (pi.get("narrative") or "")[:160].rstrip()
            lines.append(f"[{layer}·{trust}] {headline}\n  {snippet}{'…' if len(pi.get('narrative') or '') > 160 else ''}")

        prior_context_block = (
            f"\n\n━━━ ESTABLISHED FINDINGS (last run · {len(prior_insights)} items) ━━━\n"
            "These were validated in the previous analysis.\n"
            "• If current data aligns → say 'this continues' or 'still the leading driver'.\n"
            "• If current data diverges → note the shift: 'previously X, now showing Y'.\n"
            "• Do NOT invent continuity — only reference if the topic/metric appears in current analysis.\n\n"
            + "\n\n".join(lines)
            + "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        )
        logger.info(
            "node_narrate_prior_context",
            prior_count=len(prior_insights),
            preferred_count=len(preferred),
            survey_id=survey_id,
        )

    csat_score = metrics.get("csat", {}).get("score")
    trend_data = metrics.get("trend", {})

    # ── Get specialist overlay for domain-aware narration ─────────────────────
    specialist_overlay = ""
    if state.get("selected_specialists"):
        _registry = get_registry()
        _primary  = _registry.get(state["selected_specialists"][0])
        if _primary:
            specialist_overlay = _primary.manifest.prompt_overlays.narrate_system
            logger.info({
                "msg":        "node_narrate: applying specialist overlay",
                "specialist": _primary.id,
            })

    # Append prior context to specialist overlay so ALL narration calls
    # get established-findings context. The overlay is passed through to
    # narrate_topic_insight, narrate_prescriptive_insight, etc.
    # (prior_context_block is empty when suppressed by the checkpoint chain.)
    if prior_context_block:
        specialist_overlay = specialist_overlay + prior_context_block

    # ── DELTA_FACTS injection into the specialist overlay (Phase 0.5) ──────────
    # Topic + prescriptive specialists receive the overlay; prepend the code-computed
    # delta facts (authoritative for metric values) plus the trajectory block.
    # On bootstrap / null delta, prepend BASELINE_MODE instead (ESTABLISHED FINDINGS
    # is already suppressed above).
    if not is_bootstrap_run and delta_from_prior is not None:
        delta_block = _build_delta_facts_block(delta_from_prior)
        if len(ckpt_summaries) >= 2:
            delta_block = delta_block + _build_trajectory_block(ckpt_summaries)
        specialist_overlay = delta_block + specialist_overlay
    else:
        specialist_overlay = _build_baseline_mode_block() + specialist_overlay

    # NPS specialist: inject checkpoint history via prior_snapshots (reformatted).
    nps_prior_snapshots = [
        {
            "nps":            s.get("nps"),
            "captured_at":    s.get("created_at"),
            "response_count": None,  # not available in Phase 0.5 summaries
        }
        for s in ckpt_summaries
        if s.get("nps") is not None
    ]

    # ── L1: Descriptive metric insights (NPS + CSAT in parallel) ─────────────

    nps_task  = None
    csat_task = None

    if "nps" in metrics and nps_score is not None:
        m = metrics["nps"]
        n = m["n"]
        ci_low  = m.get("ci_low",  nps_score - 5)
        ci_high = m.get("ci_high", nps_score + 5)
        nps_task = narrate_nps_insight(
            score=nps_score, n=n, ci_low=ci_low, ci_high=ci_high,
            promoters=m.get("promoters"), passives=m.get("passives"), detractors=m.get("detractors"),
            # Phase 0.5: prefer checkpoint-chain NPS history; fall back to metric snapshots.
            prior_snapshots=nps_prior_snapshots or state.get("prior_snapshots"),
        )

    if "csat" in metrics and csat_score is not None:
        m = metrics["csat"]
        score     = m["score"]
        n         = m["n"]
        ci_low_c  = m.get("ci_low",  score - 0.2)
        ci_high_c = m.get("ci_high", score + 0.2)
        csat_task = narrate_csat_insight(
            score=score, n=n, ci_low=ci_low_c, ci_high=ci_high_c,
        )

    # ── L2: Diagnostic — top 5 topic clusters (all in parallel) ──────────────

    top_clusters = clusters[:5]
    topic_tasks = []
    for i, cluster in enumerate(top_clusters):
        aspect    = cluster.get("canonical_name") or cluster["aspect"]
        size      = cluster["size"]
        sentiment = cluster["dominant_sentiment"]
        emotion   = cluster["dominant_emotion"]
        sample_quotes = [t["text"][:150] for t in cluster["texts"][:3]]
        citation_ids  = [str(t["response_id"]) for t in cluster["texts"][:3]]

        topic_effort = None
        if i < len(topics):
            topic_effort = topics[i].get("effort_score")
        if topic_effort is None:
            topic_effort = compute_effort_score([t["text"] for t in cluster["texts"]])
        try:
            topic_effort = float(topic_effort)
        except (TypeError, ValueError):
            topic_effort = 4.0

        is_new = topics[i].get("is_new", False) if i < len(topics) else False

        topic_tasks.append(narrate_topic_insight(
            aspect=aspect, size=size, sentiment=sentiment, emotion=emotion,
            effort=topic_effort, is_new=is_new,
            sample_quotes=sample_quotes, citation_ids=citation_ids,
            overlay=specialist_overlay,
        ))

    # ── L3: Predictive trend ─────────────────────────────────────────────────

    trend       = trend_data.get("trend")
    forecast_7d = trend_data.get("forecast_7d")
    trend_task  = None
    if trend in ("up", "down") and forecast_7d is not None:
        trend_task = narrate_trend_insight(
            trend=trend,
            forecast_7d=int(forecast_7d),
            delta_pct=float(trend_data.get("delta_pct") or 0),
            slope=float(trend_data.get("slope") or 0),
            anomaly=bool(trend_data.get("anomaly", False)),
            total_responses=total_responses,
        )

    # ── L3/L4: Prescriptive — top negative cluster ───────────────────────────

    negative_clusters = [c for c in clusters if c["dominant_sentiment"] == "negative"]
    prescriptive_task = None
    if negative_clusters and negative_clusters[0].get("size", 0) >= 3:
        top    = negative_clusters[0]
        aspect = top.get("canonical_name") or top["aspect"]
        size_  = top["size"]
        # Build NPS-impact-sorted driver list from topic_signals for specific action grounding
        _topic_sigs = state.get("topic_signals", {})
        _top_drivers: list[dict] = []
        if _topic_sigs:
            _driver_items = [
                {"name": name, **sig}
                for name, sig in _topic_sigs.items()
                if sig.get("nps_impact") is not None
            ]
            _top_drivers = sorted(
                _driver_items,
                key=lambda x: abs(x.get("nps_impact") or 0),
                reverse=True,
            )[:5]
        prescriptive_task = narrate_prescriptive_insight(
            aspect=aspect, size=size_, sentiment="negative",
            friction_type=_infer_friction_type(aspect),
            nps_score=nps_score, csat_score=csat_score,
            effort_score=float(top.get("avg_sentiment_score", 0) or 0),
            overlay=specialist_overlay,
            top_drivers=_top_drivers or None,
        )

    # ── Fire all parallel expert calls ───────────────────────────────────────
    # Semaphore limits to 3 concurrent LLM calls: enough parallelism for speed
    # while preventing rate-limit hammering that cascades into circuit failures.

    all_tasks: list = [t for t in [nps_task, csat_task] if t is not None]
    all_tasks += topic_tasks
    all_tasks += [t for t in [trend_task, prescriptive_task] if t is not None]

    _sem = asyncio.Semaphore(3)

    async def _guarded(coro):
        async with _sem:
            return await coro

    results = await asyncio.gather(*[_guarded(t) for t in all_tasks], return_exceptions=True)

    # ── Assign results back in order ─────────────────────────────────────────

    result_idx = 0

    def _next_result():
        nonlocal result_idx
        r = results[result_idx]
        result_idx += 1
        return r

    # NPS result
    if nps_task is not None:
        m = metrics["nps"]
        n         = m["n"]
        ci_low    = m.get("ci_low",  nps_score - 5)
        ci_high   = m.get("ci_high", nps_score + 5)
        nps_result = _next_result()
        trust_score, trust_json = _build_metric_trust(
            n=n, below_minimum=m.get("below_minimum", False),
        )
        if isinstance(nps_result, NpsExpertOutput):
            headline  = nps_result.headline
            narrative = nps_result.narrative
            expert_meta = {
                "benchmark_context": nps_result.benchmark_context,
                "risk_flag": nps_result.risk_flag,
                "key_driver_hypothesis": nps_result.key_driver_hypothesis,
            }
        else:
            logger.warning("nps_expert_failed", error=str(nps_result))
            nps_disp  = int(nps_score) if nps_score == int(nps_score) else nps_score
            headline  = f"NPS is {nps_disp}"
            narrative = f"Net Promoter Score is {nps_disp} (n={n}, 95% CI: {ci_low}–{ci_high})."
            expert_meta = {}
        insights.append({
            "layer": "descriptive", "category": "metric.nps",
            "headline": headline, "narrative": narrative,
            "metric_json": {
                "name": "NPS", "value": nps_score,
                "ci_low": ci_low, "ci_high": ci_high, "unit": "points",
                **expert_meta,
            },
            "trust_score": trust_score, "trust_json": trust_json,
            "citations_json": [], "priority": 0.9,
        })

    # CSAT result
    if csat_task is not None:
        m         = metrics["csat"]
        score     = m["score"]
        n         = m["n"]
        ci_low_c  = m.get("ci_low",  score - 0.2)
        ci_high_c = m.get("ci_high", score + 0.2)
        csat_result = _next_result()
        trust_score, trust_json = _build_metric_trust(
            n=n, below_minimum=m.get("below_minimum", False),
        )
        if isinstance(csat_result, CsatExpertOutput):
            headline  = csat_result.headline
            narrative = csat_result.narrative
            expert_meta = {
                "top_box_pct": csat_result.top_box_pct,
                "benchmark_context": csat_result.benchmark_context,
                "key_driver_hypothesis": csat_result.key_driver_hypothesis,
            }
        else:
            logger.warning("csat_expert_failed", error=str(csat_result))
            headline  = f"CSAT is {score}/5 across {n} responses"
            narrative = f"Customer satisfaction averages {score}/5 (95% CI: {ci_low_c:.1f}–{ci_high_c:.1f}, n={n})."
            expert_meta = {}
        insights.append({
            "layer": "descriptive", "category": "metric.csat",
            "headline": headline, "narrative": narrative,
            "metric_json": {
                "name": "CSAT", "value": score,
                "ci_low": ci_low_c, "ci_high": ci_high_c, "scale": 5,
                **expert_meta,
            },
            "trust_score": trust_score, "trust_json": trust_json,
            "citations_json": [], "priority": 0.85,
        })

    # Topic results
    for i, cluster in enumerate(top_clusters):
        aspect    = cluster.get("canonical_name") or cluster["aspect"]
        size      = cluster["size"]
        sentiment = cluster["dominant_sentiment"]
        citations = [
            {
                "response_id": str(t["response_id"]),
                "quote":       t["text"][:200],
                "sentiment":   t["sentiment"],
                "relevance":   0.85,
                "emotion":     t.get("emotion", "neutral"),
            }
            for t in cluster["texts"][:8]
        ]
        topic_effort = None
        if i < len(topics):
            topic_effort = topics[i].get("effort_score")
        if topic_effort is None:
            topic_effort = compute_effort_score([t["text"] for t in cluster["texts"]])
        try:
            topic_effort = float(topic_effort)
        except (TypeError, ValueError):
            topic_effort = 4.0

        is_new = topics[i].get("is_new", False) if i < len(topics) else False
        citation_ids = [str(t["response_id"]) for t in cluster["texts"][:3]]
        cite_str = " ".join(f"[r{rid[:8]}]" for rid in citation_ids if rid)

        topic_result = _next_result()
        trust_score, trust_json = _build_trust(
            n=size, mentions=size, total=total_responses, cluster=cluster,
            below_minimum=size < 5,
        )
        if isinstance(topic_result, TopicExpertOutput):
            headline  = topic_result.headline
            narrative = topic_result.narrative
            expert_meta = {
                "friction_type": topic_result.friction_type,
                "root_cause_hypothesis": topic_result.root_cause_hypothesis,
                "business_impact": topic_result.business_impact,
            }
        else:
            logger.warning("topic_expert_failed", error=str(topic_result), aspect=aspect)
            new_label = " (New Topic)" if is_new else ""
            headline  = f'"{aspect}" is a top {sentiment} theme ({size} mentions){new_label}'
            narrative = f'"{aspect}" was mentioned {size} times with {sentiment} sentiment. {cite_str}'
            expert_meta = {}
        insights.append({
            "layer": "diagnostic", "category": "voice.topic",
            "headline": headline, "narrative": narrative,
            "metric_json": {
                "name": "mentions", "value": size,
                "sentiment_score": cluster["avg_sentiment_score"],
                "effort_score": topic_effort,
                "is_new_topic": is_new,
                **expert_meta,
            },
            "trust_score": trust_score, "trust_json": trust_json,
            "citations_json": citations,
            "priority": min(0.85, 0.4 + size * 0.02),
        })

    # Trend result
    if trend_task is not None:
        trend_result = _next_result()
        trust_score, trust_json = _build_trust(
            n=total_responses, mentions=total_responses, total=total_responses,
        )
        if isinstance(trend_result, TrendExpertOutput):
            headline  = trend_result.headline
            narrative = trend_result.narrative
            expert_meta = {
                "confidence": trend_result.confidence,
                "causal_hypothesis": trend_result.causal_hypothesis,
                "early_warning_signal": trend_result.early_warning_signal,
                "recommended_monitoring": trend_result.recommended_monitoring,
            }
        else:
            logger.warning("trend_expert_failed", error=str(trend_result))
            headline  = f"Response volume trending {trend} — {forecast_7d} expected next week"
            narrative = (
                f"Volume is trending {trend} with {trend_data.get('delta_pct', 0)}% delta. "
                f"Forecast: {forecast_7d} responses next 7 days."
            )
            expert_meta = {}
        insights.append({
            "layer": "predictive",
            "category": f"trend.volume_{trend}",
            "headline": headline, "narrative": narrative,
            "metric_json": {
                "name": "volume_trend", "trend": trend,
                "delta_pct": trend_data.get("delta_pct"),
                "forecast_7d": forecast_7d,
                "slope": trend_data.get("slope"),
                **expert_meta,
            },
            "trust_score": trust_score, "trust_json": trust_json,
            "citations_json": [], "priority": 0.75,
        })

        if trend == "down":
            # Fatigue prescriptive — expert-narrated using prescriptive advisor
            insights.append({
                "layer": "prescriptive",
                "category": "action.survey_fatigue",
                "headline": "Survey fatigue likely — shorten or reduce distribution frequency",
                "narrative": (
                    "Declining response volume is a leading indicator of survey fatigue. "
                    "Consider trimming to ≤7 questions and switching to pulse-style quarterly sends "
                    "to recover engagement within 4-6 weeks."
                ),
                "recommended_action": {
                    "type": "quick_win",
                    "label": "Reduce survey length and cadence",
                    "target": "survey_design",
                    "priority": "high",
                    "time_horizon": "quick_win",
                    "estimated_impact": "~20-35% response rate recovery within 30 days",
                },
                "metric_json": {"name": "volume_trend", "trend": trend},
                "trust_score": 68,
                "trust_json": {"statistical": 65, "coverage": 60, "consistency": 70, "grounding": 75},
                "citations_json": [], "priority": 0.68,
            })

    # NPS trajectory (DB lookup — sequential, after parallel gather)
    if nps_score is not None and metrics.get("nps", {}).get("n", 0) > 0:
        prior_nps: float | None = None
        try:
            async with db._pool_conn().connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(
                        """SELECT metric_json FROM insights
                           WHERE survey_id = %s AND category = 'metric.nps'
                             AND superseded_at IS NOT NULL
                           ORDER BY generated_at DESC LIMIT 1""",
                        (state["survey_id"],),
                    )
                    row = await cur.fetchone()
                    if row and row[0]:
                        mj = row[0] if isinstance(row[0], dict) else json.loads(row[0])
                        prior_nps = mj.get("value")
        except Exception:
            pass

        if prior_nps is not None and prior_nps != nps_score:
            delta = round(nps_score - prior_nps, 1)
            direction_str = "improved" if delta > 0 else "declined"
            try:
                traj_out = await narrate_trend_insight(
                    trend="up" if delta > 0 else "down",
                    forecast_7d=0,
                    delta_pct=round(delta / max(1, abs(prior_nps)) * 100, 1),
                    slope=delta,
                    anomaly=abs(delta) > 20,
                    total_responses=metrics["nps"]["n"],
                )
                headline  = traj_out.headline
                narrative = traj_out.narrative
            except Exception:
                headline  = f"NPS {direction_str} by {abs(delta)} points"
                narrative = f"NPS moved from {prior_nps} to {nps_score} ({delta:+.1f} pts)."

            trust_score, trust_json = _build_trust(
                n=metrics["nps"]["n"], mentions=metrics["nps"]["n"], total=total_responses,
            )
            insights.append({
                "layer": "predictive", "category": "trend.nps_trajectory",
                "headline": headline, "narrative": narrative,
                "metric_json": {
                    "name": "nps_trajectory", "value": nps_score,
                    "prior_value": prior_nps, "delta": delta,
                },
                "trust_score": trust_score, "trust_json": trust_json,
                "citations_json": [], "priority": 0.80,
            })

    # Prescriptive result
    if prescriptive_task is not None:
        top    = negative_clusters[0]
        aspect = top.get("canonical_name") or top["aspect"]
        size_  = top["size"]
        citations = [
            {
                "response_id": str(t["response_id"]),
                "quote":       t["text"][:200],
                "sentiment":   t["sentiment"],
                "relevance":   0.9,
                "emotion":     t.get("emotion", "neutral"),
            }
            for t in top["texts"][:5]
        ]
        presc_result = _next_result()
        trust_score, trust_json = _build_trust(
            n=size_, mentions=size_, total=total_responses, cluster=top,
            below_minimum=size_ < 5,
        )
        if isinstance(presc_result, PrescriptiveExpertOutput):
            ice_score = round((presc_result.ice_impact + presc_result.ice_confidence + presc_result.ice_ease) / 3, 1)
            action = {
                "type": presc_result.time_horizon,
                "label": presc_result.headline,
                "target": aspect,
                "priority": presc_result.priority,
                "time_horizon": presc_result.time_horizon,
                "estimated_impact": presc_result.estimated_impact,
                "ice_score": ice_score,
                "ice": {
                    "impact": presc_result.ice_impact,
                    "confidence": presc_result.ice_confidence,
                    "ease": presc_result.ice_ease,
                },
            }
            headline  = presc_result.headline
            narrative = presc_result.narrative
            priority  = min(0.95, 0.5 + ice_score * 0.045)
        else:
            logger.warning("prescriptive_expert_failed", error=str(presc_result))
            action = _prescriptive_action(top, nps_score, csat_score)
            headline  = f'Addressing "{aspect}" friction could improve satisfaction'
            narrative = (
                f'"{aspect}" is the top friction point with {size_} negative mentions. '
                "Resolving this is likely to improve NPS and CSAT scores."
            )
            priority = 0.92
        insights.append({
            "layer": "prescriptive", "category": "action.fix_friction",
            "headline": headline, "narrative": narrative,
            "recommended_action": action,
            "metric_json": {"name": "friction_volume", "value": size_},
            "trust_score": trust_score, "trust_json": trust_json,
            "citations_json": citations, "priority": priority,
        })

    # ── Apply specialist post-score priority adjustments ─────────────────────
    if state.get("selected_specialists"):
        _registry2 = get_registry()
        _primary2  = _registry2.get(state["selected_specialists"][0])
        if _primary2:
            adjusted_insights = []
            for ins in insights:
                adjusted_priority = _primary2.post_score_priority(ins, state)
                adjusted_insights.append({**ins, "priority": adjusted_priority})
            insights = adjusted_insights

    await _emit_event(run_id, "node_complete", "narrate", {"insight_count": len(insights)})
    # Pass prior_insights and anchor run_id forward so node_report_agent and
    # node_publish can use them for delta sections and audit trail respectively.
    return {**state, "insights": insights, "prior_insights": prior_insights,
            "prior_context_run_id": anchor_run_id}


# ── Node: evaluate ────────────────────────────────────────────────────────────

async def node_evaluate(state: dict) -> dict:
    """Holistic quality audit of the complete insight set.

    Uses InsightSetEvaluator to check coverage, balance, actionability, and
    redundancy. Drops redundant insights. Appends evaluation metadata to audit_json.
    """
    # Skip if insights came from cache — they were already evaluated on a prior run.
    if state.get("insights_from_cache") and not state.get("force_regenerate"):
        await _emit_event(state["run_id"], "node_complete", "evaluate", {"cache_hit": True})
        return state

    run_id   = state["run_id"]
    insights = state["insights"]
    topics   = state.get("topics", [])
    metrics  = state.get("metrics", {})
    total    = metrics.get("total_responses", 0)

    if not insights:
        return state

    try:
        eval_out = await evaluate_insight_set(
            insights=insights,
            topics=topics,
            metrics=metrics,
            total_responses=total,
        )

        # Drop redundant insights (highest index first to preserve lower indices)
        indices_to_drop = sorted(set(eval_out.redundant_indices), reverse=True)
        for idx in indices_to_drop:
            if 0 <= idx < len(insights):
                dropped = insights.pop(idx)
                logger.info(
                    "insight_dropped_redundant",
                    headline=dropped.get("headline"),
                    index=idx,
                )

        # Append evaluation scores to audit_json for each remaining insight
        eval_summary = {
            "set_quality": eval_out.overall_quality,
            "coverage_score": eval_out.coverage_score,
            "balance_score": eval_out.balance_score,
            "actionability_score": eval_out.actionability_score,
            "missing_themes": eval_out.missing_themes,
        }
        improvements_map = {imp.get("index"): imp for imp in eval_out.improvements if isinstance(imp, dict)}
        for i, ins in enumerate(insights):
            audit = ins.get("audit_json") or {}
            audit["eval"] = eval_summary
            if i in improvements_map:
                audit["eval_improvement"] = improvements_map[i].get("suggestion", "")
            ins["audit_json"] = audit

        await _emit_event(run_id, "node_complete", "evaluate", {
            "quality": eval_out.overall_quality,
            "coverage": eval_out.coverage_score,
            "balance": eval_out.balance_score,
            "actionability": eval_out.actionability_score,
            "redundant_dropped": len(indices_to_drop),
            "missing_themes": eval_out.missing_themes,
        })

    except Exception as exc:
        logger.warning("node_evaluate_failed", error=str(exc))

    return {**state, "insights": insights}


# ── Node: verify ──────────────────────────────────────────────────────────────

async def node_verify(state: dict) -> dict:
    """Verify each insight claim is supported by its citations (demote if not)."""
    await _update_heartbeat(state["run_id"])
    # Skip if insights came from cache — they were already verified on a prior run.
    if state.get("insights_from_cache") and not state.get("force_regenerate"):
        await _emit_event(state["run_id"], "node_complete", "verify", {"cache_hit": True})
        return state

    run_id   = state["run_id"]
    insights = state["insights"]

    for ins in insights:
        cit_texts = [c["quote"] for c in ins.get("citations_json", [])[:5]]
        if not cit_texts:
            continue  # metric-only insights skip verification
        ctx = "\n".join(f"- {q}" for q in cit_texts)
        try:
            if USE_SKILL_RUNTIME:
                # G2 fix: deterministic + LLM hybrid scorer replaces LLM-asks-LLM _verify()
                from crystalos.lib.hallucination_scorer import score_insight
                hs = await score_insight(
                    insight_text=ins["headline"] + " " + ins["narrative"],
                    supporting_data={"citations": cit_texts},
                )
                verifier_pass = hs.verdict in ("pass", "flag")
                ins["trust_json"]["verifier_pass"] = verifier_pass
                ins["trust_json"]["verifier_notes"] = (
                    "; ".join(hs.issues[:3]) if hs.issues else "passed"
                )
                ins["trust_json"]["hallucination_score"] = hs.score
                ins["trust_json"]["grounding"] = _trust_grounding(verifier_pass)
                if hs.verdict == "fail":
                    ins["trust_score"] = min(ins["trust_score"], 45)
                elif hs.verdict == "flag":
                    ins["trust_score"] = min(ins["trust_score"], 60)
                # Store score on insight for reasoning_trace
                ins["_hallucination_score"] = hs.score
            else:
                # Legacy: LLM-asks-LLM verifier
                result = await _verify(ins["headline"] + " " + ins["narrative"], ctx)
                verifier_pass = result.supported
                if not verifier_pass:
                    ins["trust_score"] = min(ins["trust_score"], 55)
                    ins["trust_json"]["verifier_pass"] = False
                    ins["trust_json"]["verifier_notes"] = result.reason
                    ins["trust_json"]["grounding"] = _trust_grounding(False)
                else:
                    ins["trust_json"]["verifier_pass"] = True
                    ins["trust_json"]["grounding"] = _trust_grounding(True)
        except Exception as _ve:
            # Verification service unavailable — mark explicitly so audit trail shows it.
            # Do NOT silently keep the insight at full trust; demote slightly.
            ins["trust_json"]["verifier_pass"] = None   # None = unverified (distinct from True/False)
            ins["trust_json"]["verifier_notes"] = "verification_unavailable"
            ins["trust_score"] = min(ins.get("trust_score", 70), 65)
            logger.warning("verify_service_error", headline=ins.get("headline", ""), error=str(_ve))

    await _emit_event(run_id, "node_complete", "verify", {"verified_count": len(insights)})
    return {**state, "insights": insights}


# ── Node: publish ─────────────────────────────────────────────────────────────

async def _append_metric_snapshot(state: dict) -> None:
    """Append a survey_metric_snapshots row for this run. Used by both the normal
    publish path and the skipped-checkpoint path (so the time series stays dense
    even when a checkpoint write is gated out). Never raises."""
    survey_id = state["survey_id"]
    org_id    = state["org_id"]
    run_id    = state["run_id"]
    metrics   = state.get("metrics", {})
    nps_m   = metrics.get("nps", {})
    csat_m  = metrics.get("csat", {})
    trend_m = metrics.get("trend", {})
    compl_m = metrics.get("completion", {})
    try:
        async with db._pool_conn().connection() as conn:
            await conn.execute(
                """INSERT INTO survey_metric_snapshots
                       (survey_id, org_id, run_id, captured_at,
                        response_count, nps, nps_ci_low, nps_ci_high, nps_n,
                        promoter_pct, detractor_pct, passive_pct,
                        csat, completion_rate, effort_score,
                        response_velocity_7d, anomaly_flag)
                   VALUES (%s,%s,%s,NOW(),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    survey_id, org_id, run_id,
                    metrics.get("total_responses"),
                    nps_m.get("score"), nps_m.get("ci_low"), nps_m.get("ci_high"),
                    nps_m.get("n") or None,
                    nps_m.get("promoters"), nps_m.get("detractors"), nps_m.get("passives"),
                    csat_m.get("score"),
                    compl_m.get("rate"),
                    metrics.get("effort_score"),
                    trend_m.get("recent_avg"),
                    bool(trend_m.get("anomaly", False)),
                ),
            )
    except Exception as exc:
        logger.warning("append_metric_snapshot_failed", error=str(exc))


def _checkpoint_blob_ref(row: dict) -> str | None:
    """Return the checkpoint-blob storage ref for a walked prior-checkpoint
    row, regardless of which table it came from. v2 rows store this as
    report_blob_ref; legacy rows store the equivalent concept as report_url —
    same purpose, different column name across the two schemas. Used by
    node_delta_compute (fixed 2026-07-04 to stop reading survey_insight_
    checkpoints directly and reuse resolve_context's already-walked,
    schema-aware chain instead)."""
    if row.get("schema_version") == 2:
        return row.get("report_blob_ref")
    return row.get("report_url")


def _v2_only_prior_refs(prior_chain: list) -> list[str]:
    """Extract insight_checkpoints_v2 ids from a walked prior-checkpoint chain,
    filtering out legacy-sourced rows. Fixed 2026-07-04: walk_parent_chain()
    can return LEGACY survey_insight_checkpoints rows (when v2 has no history
    yet for this survey) — their `id` is real in that table but was never
    inserted into insight_checkpoints_v2. Unlike parent_checkpoint_id (a real
    FK, so a legacy id there crashes the insert outright), lineage_json and
    the citations manifest are plain JSONB with no referential integrity, so
    this doesn't crash — it silently stores a dangling reference that Crystal's
    get_checkpoint_detail tool passes straight through as
    prior_checkpoint_refs, misinforming any lineage/trail lookup that tries to
    resolve it against insight_checkpoints_v2. Both tables stamp schema_version
    (legacy DEFAULT 1, v2 DEFAULT 2) — only a genuine v2 row's id belongs here."""
    return [
        str(p.get("id")) for p in prior_chain
        if isinstance(p, dict) and p.get("id") and p.get("schema_version") == 2
    ]


def _build_citations_manifest(state: dict, insights: list[dict]) -> dict:
    """Build the citations manifest (04 §11). Phase 2: prior_checkpoint refs come from
    walked v2 chain when available, else fall back to Phase 0.5 checkpoint_number refs."""
    response_ids: set[str] = set()
    for ins in insights:
        for c in (ins.get("citations_json") or []):
            rid = c.get("response_id")
            if rid:
                response_ids.add(str(rid))
    snapshots = state.get("metric_snapshots") or []
    snapshot_ids = [str(s.get("id")) for s in snapshots if isinstance(s, dict) and s.get("id")]
    prior_chain = state.get("prior_checkpoints") or []
    prior_refs = _v2_only_prior_refs(prior_chain)
    if not prior_refs:
        prior_refs = [
            f"checkpoint#{s['checkpoint_number']}"
            for s in (state.get("prior_checkpoint_summaries") or [])
            if isinstance(s, dict) and s.get("checkpoint_number") is not None
        ]
    return {
        "response_ids":          sorted(response_ids),
        "snapshot_ids":          snapshot_ids,
        "prior_checkpoint_refs": prior_refs,
        "total_citations":       len(response_ids),
        "generated_at":          time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def _build_lineage_json(state: dict, *, run_mode: str, blob_ref: str | None,
                        sample_stats: dict | None = None,
                        insight_report_id: str | None = None) -> dict:
    """Assemble lineage_json for an insight_checkpoints_v2 row (03 §3a)."""
    prior_chain = state.get("prior_checkpoints") or []
    prior_refs = _v2_only_prior_refs(prior_chain)
    new_ids = list(state.get("new_response_ids") or set())[:500]  # cap in-row; full list in manifest
    snapshots = state.get("metric_snapshots") or []
    snapshot_ids = [str(s.get("id")) for s in snapshots if isinstance(s, dict) and s.get("id")]
    return {
        "config_hash":          state.get("config_hash", ""),
        "pipeline_version":     "2.1.0",
        "run_mode":             run_mode,
        "prior_checkpoint_refs": prior_refs,
        "new_response_ids":     new_ids,
        "metric_snapshot_ids":  snapshot_ids,
        "insight_report_id":    insight_report_id,
        "sample_stats":         sample_stats or state.get("sample_stats") or {},
        "report_blob_ref":      blob_ref,
    }


async def _write_checkpoint_v2(
    state: dict,
    *,
    run_mode: str,
    lane: str,
    checkpoint_number: int,
    blob_ref: str | None,
    citations_manifest_ref: str | None,
    delta_from_prior: dict | None,
    meaningful_delta: bool,
    report_label: str | None = None,
    report_id: str | None = None,
) -> str | None:
    """Insert an insight_checkpoints_v2 row. Returns the new checkpoint id, or None on
    failure (the legacy write remains the source of truth during migration). Never raises."""
    survey_id = state["survey_id"]
    org_id    = state["org_id"]
    run_id    = state["run_id"]
    metrics   = state.get("metrics", {})
    trigger   = state.get("trigger", "scheduler")
    actor     = state.get("actor") or "system:scheduler"
    parent_id = state.get("parent_checkpoint_id") or None
    high_wm   = None
    # response_high_watermark = max(submitted_at) of included responses
    try:
        subs = [r.get("submitted_at") for r in state.get("responses", []) if r.get("submitted_at")]
        high_wm = max(subs) if subs else None
    except Exception:
        high_wm = None
    lineage = _build_lineage_json(state, run_mode=run_mode, blob_ref=blob_ref,
                                  insight_report_id=report_id)
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """INSERT INTO insight_checkpoints_v2
                         (survey_id, org_id, checkpoint_number, parent_checkpoint_id, lane,
                          run_id, run_mode, trigger, created_by,
                          response_count_at_checkpoint, response_high_watermark, new_response_count,
                          nps_at_checkpoint, csat_at_checkpoint, ces_at_checkpoint, topic_fingerprint,
                          delta_from_prior, meaningful_delta, lineage_json,
                          report_blob_ref, citations_manifest_ref, schema_version,
                          window_start, window_end, report_label)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       RETURNING id""",
                    (
                        survey_id, org_id, checkpoint_number, parent_id, lane,
                        run_id, run_mode, trigger, actor,
                        len(state.get("responses", [])), high_wm,
                        len(state.get("new_response_ids") or set()),
                        metrics.get("nps", {}).get("score"),
                        metrics.get("csat", {}).get("score"),
                        metrics.get("ces", {}).get("score"),
                        None,
                        json.dumps(delta_from_prior) if delta_from_prior is not None else None,
                        meaningful_delta, json.dumps(lineage),
                        blob_ref, citations_manifest_ref, 2,
                        state.get("window_start"), state.get("window_end"), report_label,
                    ),
                )
                row = await cur.fetchone()
            await conn.commit()
        new_id = str(row[0]) if row else None
        logger.info("checkpoint_v2_written", survey_id=survey_id, lane=lane,
                    run_mode=run_mode, checkpoint_number=checkpoint_number, id=new_id)
        return new_id
    except Exception as exc:
        logger.warning("checkpoint_v2_write_failed", survey_id=survey_id, error=str(exc))
        return None


async def _next_checkpoint_number(survey_id: str, org_id: str, lane: str) -> int:
    """Next monotonic checkpoint_number per (survey, org, lane) in v2. Falls back to 1."""
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT COALESCE(MAX(checkpoint_number), 0) + 1
                       FROM insight_checkpoints_v2
                       WHERE survey_id = %s AND org_id = %s AND lane = %s""",
                    (survey_id, org_id, lane),
                )
                row = await cur.fetchone()
                return int(row[0]) if row and row[0] else 1
    except Exception:
        return 1


async def node_publish_manual(state: dict) -> dict:
    """Publish branch for manual_expert / manual_quick (04 §8 manual).

    INSERT insight_reports (generating→ready), write blob + citations_manifest,
    INSERT insight_checkpoints_v2 (lane='manual', parent=latest automated). Does NOT
    supersede automated active insights. Emits SSE complete with the report URL.
    """
    survey_id = state["survey_id"]
    org_id    = state["org_id"]
    run_id    = state["run_id"]
    profile   = state.get("profile")
    insights  = state.get("insights", [])
    metrics   = state.get("metrics", {})
    actor     = state.get("actor") or "user:unknown"
    label     = state.get("report_label") or state.get("config_override", {}).get("label")
    report_id = state.get("report_id") or None
    await _update_heartbeat(run_id)

    run_mode = profile  # manual_expert | manual_quick
    ws = state.get("window_start")
    we = state.get("window_end")

    # ── Build + write report blob (v2 schema) ────────────────────────────────
    citations_manifest = _build_citations_manifest(state, insights)
    blob = {
        "schema_version": 2,
        "survey_id": survey_id,
        "org_id": org_id,
        "run_mode": run_mode,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "window_start": str(ws) if ws else None,
        "window_end": str(we) if we else None,
        "executive_summary": next(
            (i.get("narrative", "") for i in insights
             if i.get("category", "").startswith("report.executive")), ""),
        "nps": metrics.get("nps", {}).get("score"),
        "csat": metrics.get("csat", {}).get("score"),
        "ces": metrics.get("ces", {}).get("score"),
        "insights": [
            {"layer": i.get("layer"), "category": i.get("category"),
             "headline": i.get("headline"), "narrative": i.get("narrative"),
             "metric_json": i.get("metric_json", {}), "citations_json": i.get("citations_json", []),
             "trust_score": i.get("trust_score")}
            for i in insights
        ],
        "themes": [{"name": t.get("name", ""), "volume": t.get("volume", 0)}
                   for t in state.get("topics", [])[:40]],
        "metrics": metrics,
        "sample_stats": state.get("sample_stats", {}),
        "citations_manifest": citations_manifest,
    }
    blob_ref = None
    try:
        blob_ref = await write_checkpoint_blob(blob, org_id, survey_id, f"report-{run_id}")
    except Exception as exc:
        logger.error("manual_report_blob_failed", run_id=run_id, error=str(exc))

    # Optional separate citations manifest blob when large.
    manifest_ref = None
    try:
        if len(citations_manifest.get("response_ids", [])) > 1000:
            manifest_ref = await write_checkpoint_blob(
                citations_manifest, org_id, survey_id, f"manifest-{run_id}")
    except Exception:
        manifest_ref = None

    trust_scores = [i.get("trust_score") for i in insights if i.get("trust_score") is not None]
    trust_avg = round(sum(trust_scores) / len(trust_scores), 1) if trust_scores else None
    summary_headline = next((i.get("headline") for i in insights
                             if i.get("category", "").startswith("report.executive")),
                            insights[0].get("headline") if insights else None)

    # ── INSERT / UPDATE insight_reports → ready ──────────────────────────────
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                if report_id:
                    await cur.execute(
                        """UPDATE insight_reports
                           SET status='ready', blob_ref=%s, citations_manifest_ref=%s,
                               summary_headline=%s, trust_score_avg=%s
                           WHERE id=%s""",
                        (blob_ref, manifest_ref, summary_headline, trust_avg, report_id),
                    )
                else:
                    await cur.execute(
                        """INSERT INTO insight_reports
                             (survey_id, org_id, run_id, run_mode, label,
                              window_start, window_end, created_by, status,
                              blob_ref, citations_manifest_ref, summary_headline, trust_score_avg)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'ready',%s,%s,%s,%s)
                           RETURNING id""",
                        (survey_id, org_id, run_id, run_mode, label, ws, we, actor,
                         blob_ref, manifest_ref, summary_headline, trust_avg),
                    )
                    r = await cur.fetchone()
                    report_id = str(r[0]) if r else None
            await conn.commit()
    except Exception as exc:
        logger.error("insight_reports_write_failed", run_id=run_id, error=str(exc))

    # ── Optional manual checkpoint node (lane='manual', parent=latest automated) ─
    checkpoint_id = None
    if INSIGHT_CHECKPOINTS_V2_ENABLED:
        ckpt_num = await _next_checkpoint_number(survey_id, org_id, "manual")
        checkpoint_id = await _write_checkpoint_v2(
            state, run_mode=run_mode, lane="manual", checkpoint_number=ckpt_num,
            blob_ref=blob_ref, citations_manifest_ref=manifest_ref,
            delta_from_prior=state.get("delta_from_prior"),
            meaningful_delta=False, report_label=label, report_id=report_id,
        )
        if checkpoint_id and report_id:
            try:
                async with db._pool_conn().connection() as conn:
                    await conn.execute(
                        "UPDATE insight_reports SET checkpoint_id=%s WHERE id=%s",
                        (checkpoint_id, report_id),
                    )
            except Exception:
                pass

    # Append metric snapshot for the time series, mark run complete.
    await _append_metric_snapshot(state)
    try:
        async with db._pool_conn().connection() as conn:
            await conn.execute(
                """UPDATE agent_runs SET status='completed', completed_at=NOW(),
                       trigger_type=%s, new_response_count=%s
                   WHERE id=%s""",
                (state.get("trigger", "manual"), len(state.get("sample_ids") or set()), run_id),
            )
    except Exception as exc:
        logger.warning("manual_publish_run_status_failed", error=str(exc))

    report_url = f"/experience/surveys/{survey_id}/intelligence/reports/{report_id}" if report_id else None
    await _emit_event(run_id, "run_complete", "publish", {
        "manual": True, "run_mode": run_mode, "report_id": report_id,
        "report_url": report_url, "checkpoint_id": checkpoint_id,
        "published_count": len(insights), "survey_id": survey_id,
    })
    logger.info("node_publish_manual_done", run_id=run_id, run_mode=run_mode,
                report_id=report_id, checkpoint_id=checkpoint_id)
    return {**state, "report_id": report_id, "manual_report_url": report_url}


# ── AI-driven workflow triggers (Xperiq Actions Wave 3) ───────────────────────

def _aggregate_negative_pct(topic_signals: dict[str, dict]) -> float | None:
    """Response-count-weighted average `sentiment_negative_pct` across all
    topics in this run — the survey-level negative-sentiment share used as the
    sentiment_spike signal and persisted into the checkpoint blob as next
    run's baseline. Returns None when there's no topic data at all (e.g. a
    very early / no-open-text survey) rather than a misleading 0.0.
    """
    total_n = 0
    weighted_sum = 0.0
    for sig in (topic_signals or {}).values():
        n = sig.get("response_count") or 0
        pct = sig.get("sentiment_negative_pct")
        if n <= 0 or pct is None:
            continue
        total_n += n
        weighted_sum += pct * n
    if total_n == 0:
        return None
    return weighted_sum / total_n


async def node_ai_triggers(state: dict) -> dict:
    """Detect sentiment_spike / new_theme_detected / anomaly_detected signals
    and emit a `workflow_signal` for each one that fires, AFTER publish has
    finalized this run's insights/checkpoint.

    Deliberately placed as its own node after `publish` rather than folded
    into `delta_compute`/`narrate`/`publish` themselves: every signal this
    node needs (`delta_from_prior`, `meaningful_delta`, `topic_signals`,
    `metrics`, `prior_checkpoint_summaries`, `ai_trigger_baseline_negative_pct`)
    is already fully computed by the time `publish` returns — this node reads,
    it never recomputes. Detection logic itself lives in `lib/ai_triggers.py`
    (pure, unit-testable functions); this node is just the plumbing that reads
    pipeline state, calls those functions, applies Redis-backed hysteresis, and
    calls `lib/workflow_signal_client.emit_workflow_signal` for anything that
    passes both the threshold AND the hysteresis check.

    Never raises — a trigger-detection failure must not fail an otherwise-
    successful insight run (the insights are already published by the time
    this node runs). Skipped entirely when `state.get("skip_run")` or
    `state.get("skipped_checkpoint")` — a run with no meaningful new signal
    is definitionally not a candidate for a NEW AI trigger to fire on top of.

    Also skipped for manual/refresh profiles (`manual_expert`, `manual_quick`,
    `refresh`) — those are explicit, user-requested deep-dives over an
    arbitrary window, not part of the regular automated checkpoint cadence the
    hysteresis/baseline model (rolling vs. the immediately-prior AUTOMATED
    checkpoint) assumes. Comparing a manual refresh's window against the
    automated baseline would conflate two different sampling populations and
    could fire (or wrongly suppress) a trigger based on a non-comparable
    snapshot.
    """
    if state.get("skip_run") or state.get("skipped_checkpoint"):
        return state

    profile = state.get("profile") or INSIGHT_PROFILE_AUTOMATED
    if profile != INSIGHT_PROFILE_AUTOMATED:
        return state

    survey_id = state.get("survey_id")
    org_id = state.get("org_id")
    run_id = state.get("run_id")
    if not survey_id or not org_id:
        return state

    try:
        from crystalos.lib import ai_triggers as at
        from crystalos.lib.redis_keys import K
        from crystalos.lib.workflow_signal_client import emit_workflow_signal

        brand_id = None  # AI triggers are a first-party-org feature for v1; brand_id namespacing is a no-op today
        delta = state.get("delta_from_prior") or {}
        topic_signals = state.get("topic_signals") or {}
        metrics = state.get("metrics") or {}
        prior_summaries = state.get("prior_checkpoint_summaries") or []
        detected_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        fired: list[at.TriggerSignal] = []

        # ── sentiment_spike ────────────────────────────────────────────────
        current_negative_pct = _aggregate_negative_pct(topic_signals)
        baseline_negative_pct = state.get("ai_trigger_baseline_negative_pct")
        new_response_count = len(state.get("new_response_ids") or []) or delta.get("response_count_delta", 0)
        if current_negative_pct is not None:
            key = K.ai_trigger_armed(brand_id, survey_id, "sentiment_spike")
            armed_state = await at.get_armed_state(key)
            was_armed = armed_state is not None
            signal = at.detect_sentiment_spike(
                current_negative_pct, baseline_negative_pct, new_response_count, was_armed=was_armed,
            )
            if signal and (not was_armed or at.cooldown_elapsed(armed_state, at.SENTIMENT_SPIKE_COOLDOWN_HOURS)):
                fired.append(signal)
                await at.set_armed_state(key)
            elif not signal and was_armed:
                await at.clear_armed_state(key)

        # ── new_theme_detected ─────────────────────────────────────────────
        emerged = (delta.get("topic_changes") or {}).get("emerged") or []
        for signal in at.detect_new_theme(emerged, topic_signals):
            topic_name = signal.payload.get("topic_name", "_")
            key = K.ai_trigger_armed(brand_id, survey_id, "new_theme_detected", topic_name)
            armed_state = await at.get_armed_state(key)
            if armed_state is None or at.cooldown_elapsed(armed_state, at.NEW_THEME_COOLDOWN_HOURS):
                fired.append(signal)
                await at.set_armed_state(key)

        # ── anomaly_detected (NPS today; extend metric_name list as more
        # tracked metrics grow rolling history worth alarming on) ──────────
        nps_history = [s["nps"] for s in prior_summaries if s.get("nps") is not None]
        current_nps = (metrics.get("nps") or {}).get("score")
        key = K.ai_trigger_armed(brand_id, survey_id, "anomaly_detected", "nps")
        armed_state = await at.get_armed_state(key)
        was_armed = armed_state is not None
        signal = at.detect_metric_anomaly("NPS", current_nps, nps_history, was_armed=was_armed)
        if signal and (not was_armed or at.cooldown_elapsed(armed_state, at.ANOMALY_COOLDOWN_HOURS)):
            fired.append(signal)
            await at.set_armed_state(key)
        elif not signal and was_armed:
            await at.clear_armed_state(key)

        for sig in fired:
            await emit_workflow_signal(
                org_id=org_id,
                signal_type=sig.trigger_type,
                confidence=sig.confidence,
                survey_id=survey_id,
                detected_at=detected_at,
                source_run_id=run_id,
                payload={**sig.payload, "severity": sig.severity, "summary": sig.summary},
            )

        if fired:
            logger.info(
                "node_ai_triggers_fired",
                survey_id=survey_id, run_id=run_id,
                signal_types=[s.trigger_type for s in fired],
            )
    except Exception as exc:
        logger.warning("node_ai_triggers_failed", survey_id=survey_id, run_id=run_id, error=str(exc))

    return state


async def node_publish(state: dict) -> dict:
    """Insert insight rows into DB, supersede old ones, and add per-window metrics."""
    survey_id = state["survey_id"]
    org_id    = state["org_id"]
    run_id    = state["run_id"]
    await _update_heartbeat(run_id)

    # ── skip_run backstop ─────────────────────────────────────────────────────
    # node_ingest already marked the run completed on skip; if we somehow reach
    # publish with skip_run set, do nothing further.
    if state.get("skip_run"):
        await _emit_event(run_id, "run_complete", "publish",
                          {"skipped": True, "reason": state.get("skip_reason", "skipped")})
        return state

    # ── Manual modes → separate publish branch (additive, no supersede) ───────
    profile = state.get("profile") or INSIGHT_PROFILE_AUTOMATED
    if profile in (INSIGHT_PROFILE_MANUAL_EXPERT, INSIGHT_PROFILE_MANUAL_QUICK):
        return await node_publish_manual(state)

    insights  = state["insights"]
    responses = state["responses"]
    metrics   = state["metrics"]

    # ── Checkpoint write gate (Insight Pipeline v2 §8/§9) ─────────────────────
    # delta_from_prior / meaningful_delta come from node_delta_compute and are already
    # in state (they propagate even through the narrate cache-hit path).
    delta_from_prior  = state.get("delta_from_prior")
    meaningful_delta  = bool(state.get("meaningful_delta", True))
    is_bootstrap      = bool(state.get("is_bootstrap", False))
    trigger_for_gate  = state.get("trigger", "schedule")
    is_tier_milestone = (
        len(responses) in _TIER_MILESTONE_COUNTS
        or trigger_for_gate == "milestone"
    )
    should_write_checkpoint = meaningful_delta or is_bootstrap or is_tier_milestone

    # When the delta is not meaningful and this is neither a bootstrap nor a tier
    # milestone, skip the checkpoint write AND the active-projection supersede.
    # The metric snapshot is still appended (below) and the run is marked completed.
    if not should_write_checkpoint:
        logger.info(
            "node_publish_skipped_checkpoint",
            survey_id=survey_id, run_id=run_id,
            nps_delta=(delta_from_prior or {}).get("nps_delta"),
            response_count=len(responses),
        )
        await _append_metric_snapshot(state)
        try:
            async with db._pool_conn().connection() as conn:
                await conn.execute(
                    """UPDATE agent_runs
                       SET status='completed', completed_at=NOW(), trigger_type=%s,
                           new_response_count=%s
                       WHERE id=%s""",
                    (trigger_for_gate, len(state.get("new_response_ids") or set()), run_id),
                )
        except Exception as exc:
            logger.warning("node_publish_skip_status_failed", error=str(exc))
        await _emit_event(run_id, "run_complete", "publish", {
            "published_count": 0, "survey_id": survey_id, "skipped_checkpoint": True,
        })
        return {**state, "skipped_checkpoint": True}

    # Capture user state (pins, thumbs, dismissals) from currently active insights
    # keyed by category:time_window so re-generation carries them forward even when
    # the insight headline (and therefore its hash) changes.
    prior_user_states: dict[str, dict] = {}
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT category, time_window, user_state_json
                       FROM insights
                       WHERE survey_id = %s AND org_id = %s AND superseded_at IS NULL
                         AND user_state_json IS NOT NULL
                         AND user_state_json != '{}'::jsonb""",
                    (survey_id, org_id),
                )
                for row in await cur.fetchall():
                    key = f"{row[0]}:{row[1]}"
                    prior_user_states[key] = row[2] if isinstance(row[2], dict) else {}
    except Exception:
        pass

    import traceback as _tb

    # ── Phase 1: Atomic insight publish ──────────────────────────────────────────
    # All supersede + upsert operations happen inside a single transaction.
    # If any step fails, the entire batch is rolled back — no partial states.
    published = 0
    # When a stream/schedule trigger skips report generation (delta too small),
    # preserve existing report.* insights so the Report page stays populated.
    # Manual or forced runs always regenerate the report and supersede everything.
    has_new_report = any(ins.get("category", "").startswith("report.") for ins in insights)
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.transaction():
                if has_new_report:
                    # New report generated — supersede everything including old report
                    await conn.execute(
                        """UPDATE insights SET superseded_at = NOW(), superseded_by = NULL
                           WHERE survey_id = %s AND org_id = %s AND superseded_at IS NULL""",
                        (survey_id, org_id),
                    )
                else:
                    # Report skipped this run — only supersede non-report insights so
                    # the existing report.* rows survive for the Report page
                    await conn.execute(
                        """UPDATE insights SET superseded_at = NOW(), superseded_by = NULL
                           WHERE survey_id = %s AND org_id = %s AND superseded_at IS NULL
                             AND category NOT LIKE 'report.%%'""",
                        (survey_id, org_id),
                    )

                # Publish main (all_time) insights
                for ins in insights:
                    await _publish_one(conn, survey_id, org_id, run_id, ins, "all_time", prior_user_states)
                    published += 1
                logger.info("node_publish_main_done", published=published, total=len(insights))

                # Per-window metric insights (cheap — no LLM)
                for window in ["last_30d", "last_7d"]:
                    windowed = filter_responses_by_window(responses, window)
                    min_n = WINDOW_MIN_RESPONSES[window]
                    if len(windowed) < min_n:
                        continue

                    w_metrics: dict = {}
                    if any(r.get("nps_score") is not None for r in windowed):
                        w_metrics["nps"] = compute_nps_ci(windowed)
                    if any(r.get("csat_score") is not None for r in windowed):
                        w_metrics["csat"] = compute_csat(windowed)
                    w_total = len(windowed)

                    if "nps" in w_metrics and w_metrics["nps"].get("score") is not None:
                        m = w_metrics["nps"]
                        score = m["score"]
                        n = m["n"]
                        ci_low = m.get("ci_low", score - 5)
                        ci_high = m.get("ci_high", score + 5)
                        trust_score, trust_json = _build_metric_trust(n=n)
                        w_ins = {
                            "layer": "descriptive", "category": "metric.nps",
                            "headline": f"NPS is {score} ({window.replace('_', ' ')})",
                            "narrative": (
                                f"Over the {window.replace('_', ' ')}, NPS is {score} "
                                f"(95% CI: {ci_low}–{ci_high}, n={n})."
                            ),
                            "metric_json": {"name": "NPS", "value": score, "ci_low": ci_low, "ci_high": ci_high},
                            "trust_score": trust_score, "trust_json": trust_json,
                            "citations_json": [], "priority": 0.88,
                        }
                        await _publish_one(conn, survey_id, org_id, run_id, w_ins, window, prior_user_states)

                    if "csat" in w_metrics and w_metrics["csat"].get("score") is not None:
                        m = w_metrics["csat"]
                        score = m["score"]
                        n = m["n"]
                        ci_low_c = m.get("ci_low", score - 0.2)
                        ci_high_c = m.get("ci_high", score + 0.2)
                        trust_score, trust_json = _build_metric_trust(n=n)
                        w_ins = {
                            "layer": "descriptive", "category": "metric.csat",
                            "headline": f"CSAT is {score}/5 ({window.replace('_', ' ')})",
                            "narrative": (
                                f"Over the {window.replace('_', ' ')}, CSAT is {score}/5 "
                                f"(95% CI: {ci_low_c:.2f}–{ci_high_c:.2f}, n={n})."
                            ),
                            "metric_json": {"name": "CSAT", "value": score, "ci_low": ci_low_c, "ci_high": ci_high_c, "scale": 5},
                            "trust_score": trust_score, "trust_json": trust_json,
                            "citations_json": [], "priority": 0.83,
                        }
                        await _publish_one(conn, survey_id, org_id, run_id, w_ins, window, prior_user_states)

    except Exception as exc:
        logger.error(
            "node_publish_phase1_failed",
            error=str(exc),
            traceback=_tb.format_exc(),
            hint="Check that insights table has time_window column + insights_hash_window_unique index",
        )
        try:
            async with db._pool_conn().connection() as conn:
                await conn.execute(
                    "UPDATE agent_runs SET status='failed', completed_at=NOW() WHERE id=%s",
                    (run_id,),
                )
        except Exception:
            pass
        raise

    # ── Phase 2: Derived data updates ────────────────────────────────────────────
    # Only runs after Phase 1 committed successfully.
    # Failures here don't roll back the published insights.
    try:
        # Collect sampled response IDs for the audit trail.
        # This is the ONLY place response IDs are persisted — keyed by run_id.
        # Audit chain: insight.run_id → agent_runs.sampled_response_ids → response rows.
        sampled_ids          = [str(r["id"]) for r in state.get("responses", []) if r.get("id")]
        new_response_count   = len(state.get("new_response_ids") or set())
        prior_ctx_run_id     = state.get("prior_context_run_id") or None
        trigger_type         = state.get("trigger", "manual")
        async with db._pool_conn().connection() as conn:
            await conn.execute(
                """UPDATE agent_runs
                   SET status='completed', completed_at=NOW(),
                       trigger_type=%s,
                       sampled_response_ids=%s,
                       sampled_response_count=%s,
                       new_response_count=%s,
                       prior_context_run_id=%s
                   WHERE id=%s""",
                (trigger_type, json.dumps(sampled_ids), len(sampled_ids),
                 new_response_count, prior_ctx_run_id, run_id),
            )
    except Exception as exc:
        logger.warning("node_publish_run_status_failed", error=str(exc), traceback=_tb.format_exc())

    # Record run duration histogram
    try:
        from crystalos.lib.metrics import agent_run_duration_seconds
        import time as _time_mod
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT created_at FROM agent_runs WHERE id = %s",
                    (run_id,),
                )
                row = await cur.fetchone()
                if row and row[0]:
                    from datetime import timezone
                    started = row[0]
                    if hasattr(started, 'tzinfo') and started.tzinfo:
                        duration = _time_mod.time() - started.timestamp()
                    else:
                        duration = 0
                    trigger = state.get("trigger", "schedule")
                    agent_run_duration_seconds.labels(trigger=trigger).observe(duration)
                    # SLO histogram: per-profile, per-org run duration
                    try:
                        from crystalos.lib.metrics import insight_run_duration_seconds
                        _profile = state.get("profile", "automated_incremental")
                        insight_run_duration_seconds.labels(
                            profile=_profile, org_id=org_id
                        ).observe(duration)
                    except Exception:
                        pass
    except Exception:
        pass

    # Write NPS score back to the surveys table so the survey list and org analytics
    # reflect the latest computed NPS without a separate query.
    nps_data = metrics.get("nps", {})
    nps_score = nps_data.get("score")
    if nps_score is not None:
        try:
            async with db._pool_conn().connection() as conn:
                await conn.execute(
                    "UPDATE surveys SET nps_score = %s WHERE id = %s",
                    (nps_score, survey_id),
                )
        except Exception as exc:
            logger.warning("node_publish_nps_writeback_failed", error=str(exc))

    # Snapshot per-run metrics for time-series dashboards
    nps_m   = metrics.get("nps", {})
    csat_m  = metrics.get("csat", {})
    trend_m = metrics.get("trend", {})
    compl_m = metrics.get("completion", {})
    try:
        async with db._pool_conn().connection() as conn:
            await conn.execute(
                """INSERT INTO survey_metric_snapshots
                       (survey_id, org_id, run_id, captured_at,
                        response_count, nps, nps_ci_low, nps_ci_high, nps_n,
                        promoter_pct, detractor_pct, passive_pct,
                        csat, completion_rate, effort_score,
                        response_velocity_7d, anomaly_flag)
                   VALUES (%s,%s,%s,NOW(),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    survey_id, org_id, run_id,
                    metrics.get("total_responses"),
                    nps_m.get("score"), nps_m.get("ci_low"), nps_m.get("ci_high"),
                    nps_m.get("n") or None,
                    nps_m.get("promoters"), nps_m.get("detractors"), nps_m.get("passives"),
                    csat_m.get("score"),
                    compl_m.get("rate"),
                    metrics.get("effort_score"),
                    trend_m.get("recent_avg"),
                    bool(trend_m.get("anomaly", False)),
                ),
            )
    except Exception as exc:
        logger.warning("node_publish_metric_snapshot_failed", error=str(exc))

    # Write checkpoint blob + row
    # delta_from_prior / meaningful_delta are computed by node_delta_compute and carried
    # in state (they survive the narrate cache-hit path). We persist them here verbatim
    # rather than recomputing — the delta is authoritative for the whole run.
    try:
        from crystalos.lib import db as _db

        prior_delta = delta_from_prior  # from node_delta_compute (gate block above)

        checkpoint_number = 1
        async with _db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT COALESCE(MAX(checkpoint_number), 0) + 1 FROM survey_insight_checkpoints WHERE survey_id = %s AND org_id = %s",
                    (survey_id, org_id),
                )
                row = await cur.fetchone()
                checkpoint_number = row[0] if row else 1

        report_blob = {
            "schema_version": CHECKPOINT_BLOB_SCHEMA_VERSION,
            "survey_id": survey_id,
            "org_id": org_id,
            "checkpoint_number": checkpoint_number,
            "response_count": len(responses),
            "nps": metrics.get("nps", {}).get("score"),
            "csat": metrics.get("csat", {}).get("score"),
            "ces": metrics.get("ces", {}).get("score"),
            "insights": [{"id": str(ins.get("id", "")), "headline": ins.get("headline", ""), "layer": ins.get("layer", "")} for ins in insights[:50]],
            "topics": [{"name": t.get("name", ""), "volume": t.get("volume", 0)} for t in state.get("topics", [])[:20]],
            "metrics": metrics,
            "delta": prior_delta,
            # Xperiq Actions Wave 3 (AI triggers) — additive field, read back by
            # the NEXT run's node_delta_compute as the sentiment_spike rolling
            # baseline. See lib/ai_triggers.py / WORKFLOW_SIGNAL_CONTRACT.md.
            "ai_trigger_negative_pct": _aggregate_negative_pct(state.get("topic_signals") or {}),
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

        checkpoint_id = f"ckpt-{run_id}"
        blob_ref = await write_checkpoint_blob(report_blob, org_id, survey_id, checkpoint_id)

        if not STOP_LEGACY_CHECKPOINT_WRITE:
            async with _db._pool_conn().connection() as conn:
                await conn.execute(
                    """INSERT INTO survey_insight_checkpoints
                       (survey_id, org_id, checkpoint_number, trigger, response_count_at_checkpoint,
                        nps_at_checkpoint, csat_at_checkpoint, ces_at_checkpoint, report_url, schema_version,
                        delta_from_prior, meaningful_delta)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (
                        survey_id, org_id, checkpoint_number,
                        state.get("trigger", "schedule"),
                        len(responses),
                        metrics.get("nps", {}).get("score"),
                        metrics.get("csat", {}).get("score"),
                        metrics.get("ces", {}).get("score"),
                        blob_ref,
                        CHECKPOINT_BLOB_SCHEMA_VERSION,
                        json.dumps(prior_delta) if prior_delta is not None else None,
                        meaningful_delta,
                    ),
                )
        logger.info(
            "checkpoint_written",
            survey_id=survey_id, checkpoint_number=checkpoint_number, ref=blob_ref,
            meaningful_delta=meaningful_delta,
        )
        # Emit checkpoint_written SSE event into agent_runs.stream_events so the
        # backend SSE handler streams it to the Intelligence page automatically.
        await _emit_event(run_id, "checkpoint_written", "publish", {
            "checkpoint_number": checkpoint_number,
            "nps": metrics.get("nps", {}).get("score"),
            "meaningful": meaningful_delta,
        })

        # ── Phase 1+ dual-write: insight_checkpoints_v2 (automated lane) ───────
        # Write the v2 linked-list row (parent_checkpoint_id + lineage_json) IN
        # ADDITION to the legacy table during migration. Gated by a constant; never
        # fails the run (the legacy write above remains source of truth).
        if INSIGHT_CHECKPOINTS_V2_ENABLED:
            try:
                manifest = _build_citations_manifest(state, insights)
                manifest_ref = None
                if len(manifest.get("response_ids", [])) > 1000:
                    manifest_ref = await write_checkpoint_blob(
                        manifest, org_id, survey_id, f"manifest-{run_id}")
                v2_num = await _next_checkpoint_number(survey_id, org_id, "automated")
                v2_id = await _write_checkpoint_v2(
                    state, run_mode=INSIGHT_PROFILE_AUTOMATED, lane="automated",
                    checkpoint_number=v2_num, blob_ref=blob_ref,
                    citations_manifest_ref=manifest_ref,
                    delta_from_prior=prior_delta, meaningful_delta=meaningful_delta,
                )
                # Advance parent pointer so a later node (or same-process chaining)
                # links correctly; harmless for single-run invocations.
                if v2_id:
                    state["parent_checkpoint_id"] = v2_id
            except Exception as _v2e:
                logger.warning("checkpoint_v2_dual_write_failed", error=str(_v2e))
    except Exception as exc:
        logger.error("checkpoint_write_failed", error=str(exc), traceback=traceback.format_exc())

    published_total = len(insights)

    # G26 — Reasoning trace: write audit trail to each published insight
    # Stores which tool results supported the insight, hallucination score, eval score,
    # and the model used — enables GDPR right to explanation and SOC2 audit.
    try:
        async with db._pool_conn().connection() as _trace_conn:
            for ins in insights:
                ins_id = ins.get("id") or ins.get("insight_id")
                if not ins_id:
                    continue
                _trace = {
                    "supporting_tool_results": ins.get("citations_json", [])[:3],
                    "hallucination_score": ins.get("_hallucination_score"),
                    "eval_score": ins.get("_eval_score"),
                    "eval_issues": ins.get("_eval_issues", []),
                    "model": (ins.get("audit_json") or {}).get("model", "insight_narrate"),
                    "skill_source": (ins.get("metric_json") or {}).get("source"),
                    "schema_version": 1,
                }
                await _trace_conn.execute(
                    "UPDATE insights SET reasoning_trace = %s WHERE id = %s",
                    (json.dumps(_trace), str(ins_id)),
                )
    except Exception as _te:
        logger.debug("reasoning_trace_write_failed", error=str(_te))

    # G27 — Audit log: write per-insight audit rows to insight_audit_log for
    # SOC2 compliance, GDPR right-to-explanation, and SLO tracking.
    try:
        audit_rows = []
        for ins in insights:
            ins_id = ins.get("id") or ins.get("insight_id")
            if not ins_id:
                continue
            citation_count = len(ins.get("citations_json") or [])
            # citation_valid_count: count citations that map to a real response ID.
            # The hallucination filter in node_verify strips invalid IDs, so all
            # remaining citations are valid — citation_valid_count == citation_count post-filter.
            citation_valid_count = citation_count
            verifier_pass = ins.get("_eval_score", 1.0) is not None and ins.get("_eval_score", 1.0) >= 0.7
            verifier_score_raw = ins.get("_eval_score")
            verifier_score = float(verifier_score_raw) if verifier_score_raw is not None else None
            hallucination_raw = ins.get("_hallucination_score")
            hallucination_score = float(hallucination_raw) if hallucination_raw is not None else None
            # prompt_hash: prefer the one the narrate node computed; fall back to a
            # deterministic run fingerprint so the column is never silently NULL.
            _audit_json = ins.get("audit_json") or {}
            prompt_hash = _audit_json.get("prompt_hash") or _audit_json.get("prompt_sha256")
            if not prompt_hash:
                import hashlib as _hl
                prompt_hash = _hl.sha256(f"{org_id}:{run_id}:{ins_id}".encode()).hexdigest()
            audit_rows.append((
                str(ins_id),           # 0  insight_id
                run_id,                # 1  run_id
                str(survey_id),        # 2  survey_id
                org_id,                # 3  org_id
                str(state.get("checkpoint_id") or ""),  # 4  checkpoint_id
                _audit_json.get("model", "insight_narrate"),  # 5  model
                0.1,  # temperature for narrate specialists per PIPELINE_SPEC §13  # 6
                state.get("profile", "automated_incremental"),  # 7  run_mode
                verifier_pass,         # 8  verifier_pass  ← index used by metrics
                verifier_score,        # 9  verifier_score
                json.dumps(ins.get("_eval_issues") or []),  # 10  verifier_notes
                hallucination_score,   # 11  hallucination_score
                citation_count,        # 12  citation_count  ← index used by metrics
                citation_valid_count,  # 13  citation_valid_count  ← index used by metrics
                prompt_hash,           # 14  prompt_hash (added last to preserve metric indices)
            ))

        if audit_rows:
            async with db._pool_conn().connection() as _audit_conn:
                for row in audit_rows:
                    await _audit_conn.execute(
                        """INSERT INTO insight_audit_log
                           (insight_id, run_id, survey_id, org_id, checkpoint_id,
                            model, temperature, run_mode,
                            verifier_pass, verifier_score, verifier_notes,
                            hallucination_score, citation_count, citation_valid_count,
                            prompt_hash)
                           VALUES (%s, %s, %s, %s, NULLIF(%s, ''),
                                   %s, %s, %s,
                                   %s, %s, %s::jsonb,
                                   %s, %s, %s,
                                   %s)""",
                        row,
                    )
            logger.info("audit_log_written", survey_id=survey_id,
                        run_id=run_id, count=len(audit_rows))

        # Increment SLO Prometheus counters (best-effort — never blocks the run)
        try:
            from crystalos.lib.metrics import (
                insight_citation_total, insight_citation_valid_total,
                insight_verifier_total, insight_verifier_pass_total,
            )
            labels = {"org_id": org_id}
            total_citations = sum(r[12] for r in audit_rows)   # citation_count column index
            total_valid = sum(r[13] for r in audit_rows)        # citation_valid_count column index
            total_pass = sum(1 for r in audit_rows if r[8])     # verifier_pass column index
            insight_citation_total.labels(**labels).inc(total_citations)
            insight_citation_valid_total.labels(**labels).inc(total_valid)
            insight_verifier_total.labels(**labels).inc(len(audit_rows))
            insight_verifier_pass_total.labels(**labels).inc(total_pass)
        except Exception:
            pass  # metrics are best-effort
    except Exception as _audit_err:
        # Audit log write failure NEVER blocks the run — log and continue.
        logger.warning("audit_log_write_failed", survey_id=survey_id,
                       run_id=run_id, error=str(_audit_err))

    # ── Action recommendations (async, non-blocking) ─────────────────────────
    # Run the action-recommender skill after every successful publish.
    # Results are stored in the DB (action_recommendations table) and surfaced
    # via the /api/insights/:surveyId/actions endpoint.
    asyncio.create_task(_generate_action_recommendations(state))

    # G28 + L3 — Warm survey facts cache and invalidate stale L1 semantic cache
    try:
        import os as _os
        _redis_url = _os.getenv("REDIS_URL", "")
        if _redis_url:
            import redis.asyncio as _redis_mod
            _r = await _redis_mod.from_url(_redis_url)
            try:
                from crystalos.lib.memory import get_memory_manager
                _mm = get_memory_manager(redis=_r)

                # Write authoritative L3 survey facts (overwrites any cold-start warm data)
                _nps = metrics.get("nps", {})
                _csat = metrics.get("csat", {})
                _ces  = metrics.get("ces", {})
                _survey_facts = {
                    "survey_id": survey_id,
                    "computed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "response_count": metrics.get("total_responses", 0),
                    "survey_type": state.get("survey_type", "custom"),
                    "nps_score": _nps.get("score"),
                    "csat_score": _csat.get("score"),
                    "ces_score":  _ces.get("score"),
                    "top_topics": [
                        {"label": t.get("name", ""), "volume": t.get("volume", 0),
                         "sentiment": float(t.get("sentiment_score", 0.0))}
                        for t in state.get("topics", [])[:5]
                    ],
                    "run_id": run_id,
                }
                await _mm.set_survey_facts(survey_id, _survey_facts)

                # Invalidate L1 semantic cache so next Crystal session gets fresh data
                invalidated = await _mm.invalidate_survey_cache(org_id, survey_id)
                logger.info(
                    "node_publish_memory_warmed",
                    survey_id=survey_id,
                    l1_invalidated=invalidated,
                )
            finally:
                await _r.close()
    except Exception as _me:
        logger.debug("node_publish_memory_warm_failed", error=str(_me))

    await _emit_event(run_id, "run_complete", "publish", {
        "published_count": published_total, "survey_id": survey_id,
    })

    from crystalos.lib.event_publisher import publish_run_event
    total_cost = sum(
        ins.get("metric_json", {}).get("cost_usd", 0.0) or 0.0
        for ins in insights
        if isinstance(ins.get("metric_json"), dict)
    )
    await publish_run_event(
        "run_completed",
        run_id=run_id,
        org_id=org_id,
        survey_id=survey_id,
        metadata={"insight_count": published_total, "cost_usd": total_cost},
    )

    # G29 — Emit notification so the user sees "Insights ready" in the UI bar.
    # Fails silently — never blocks insight delivery.
    try:
        import os as _os_n
        _redis_url_n = _os_n.getenv("REDIS_URL", "")
        if _redis_url_n:
            import redis.asyncio as _redis_n_mod
            _r_n = await _redis_n_mod.from_url(_redis_url_n)
            try:
                # Look up the user who triggered this run so the notification
                # targets them directly rather than falling back to org admins.
                _target_users: list[str] = []
                try:
                    async with db._pool_conn().connection() as _nc:
                        async with _nc.cursor() as _ncur:
                            await _ncur.execute(
                                "SELECT user_id FROM agent_runs WHERE id = %s", (run_id,)
                            )
                            _run_row = await _ncur.fetchone()
                            if _run_row and _run_row[0]:
                                _target_users = [str(_run_row[0])]
                except Exception:
                    pass
                _rc_n = len(responses)
                _n_word = "insight" if published_total == 1 else "insights"
                _summary_n = (
                    f"Crystal surfaced {published_total} {_n_word}"
                    + (f" from {_rc_n} responses." if _rc_n else ".")
                )
                from crystalos.lib.notification_bridge import publish_notification_event
                await publish_notification_event(
                    _r_n,
                    type="crystal.insight_ready",
                    org_id=org_id,
                    target_user_ids=_target_users,
                    entity_type="survey",
                    entity_id=survey_id,
                    priority="info",
                    title="Insights ready",
                    payload={
                        "insightCount": published_total,
                        "responseCount": _rc_n,
                        "crystalSummary": _summary_n,
                        "actionUrl": f"/app/surveys/{survey_id}/insights",
                    },
                )
                logger.info(
                    "node_publish_notification_sent",
                    published=published_total,
                    target_users=_target_users,
                )
            finally:
                await _r_n.close()
    except Exception as _ne:
        logger.warning("node_publish_notify_failed", error=str(_ne))

    return state


async def _publish_one(
    conn,
    survey_id: str,
    org_id: str,
    run_id: str,
    ins: dict,
    time_window: str,
    prior_user_states: dict[str, dict] | None = None,
) -> None:
    """Insert a single insight row with ON CONFLICT upsert.

    Preserves user_state_json (pins, thumbs, dismissals) from the previous
    generation when the insight changes by carrying state forward by category.

    Hash uses a stable_key derived from category + topic/metric identifier so
    headline rewrites update the existing row rather than creating orphan rows.
    """
    import re as _re

    def _stable_key(ins: dict) -> str:
        category    = ins["category"]
        metric_json = ins.get("metric_json") or {}
        if category == "voice.topic":
            # Normalize topic name: lowercase, strip punctuation, sort words for stability
            topic = metric_json.get("topic") or metric_json.get("theme") or ins.get("headline", "")
            normalized = " ".join(sorted(_re.sub(r"[^a-z0-9 ]", "", topic.lower()).split()))
            return f"{category}:{normalized}"
        elif category in ("metric.nps", "metric.csat", "metric.ces", "metric.trend", "metric.completion"):
            return category  # Only one per survey per window
        elif category.startswith("report."):
            # For report insights, use category + normalized theme name (not full headline)
            theme = metric_json.get("theme") or metric_json.get("report_tier", "")
            if theme:
                norm = _re.sub(r"[^a-z0-9 ]", "", theme.lower())[:30].strip()
                return f"{category}:{norm}"
            # Structural report insights (executive_summary, priority_action) — use category
            return category
        else:
            # Default: category + first 40 chars of normalized headline
            norm = _re.sub(r"[^a-z0-9 ]", "", ins.get("headline", "").lower())[:40].strip()
            return f"{category}:{norm}"

    stable_key   = _stable_key(ins)
    canonical    = json.dumps({"survey_id": survey_id, "key": stable_key, "time_window": time_window}, sort_keys=True)
    insight_hash = hashlib.sha256(canonical.encode()).hexdigest()[:32]

    # Merge incoming audit_json (set by tiered_report with prior_insight_refs /
    # new_response_refs) with system metadata. Incoming fields take precedence
    # so lineage data from report generation is preserved.
    _incoming_audit = _parse_json_field(ins.get("audit_json")) or {}
    audit_json = {
        "model":           _incoming_audit.get("model", "insight_narrate"),
        "embedding_model": "text-embedding-3-small",
        "temperature":     INSIGHT_TEMPERATURE,
        "seed":            DEFAULT_SEED,
        "verifier_pass":   ins.get("trust_json", {}).get("verifier_pass", True),
        "run_id":          run_id,
        "prompt_hash":     hashlib.sha256(ins["headline"].encode()).hexdigest()[:16],
        "time_window":     time_window,
        # Lineage fields from tiered_report — preserved verbatim
        **{k: v for k, v in _incoming_audit.items()
           if k in ("prior_insight_refs", "new_response_refs",
                    "prior_insight_count", "new_response_count",
                    "report_tier", "theme")},
    }

    # Carry over user feedback from the previous run for the same insight category.
    # This ensures pins and thumbs survive headline rewrites.
    user_state: dict = {}
    if prior_user_states:
        user_state = prior_user_states.get(f"{ins['category']}:{time_window}", {})

    await conn.execute(
        """INSERT INTO insights (
             survey_id, org_id, run_id, layer, category,
             headline, narrative, recommended_action,
             metric_json, citations_json,
             trust_score, trust_json, priority,
             insight_hash, audit_json, user_state_json, time_window
           ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (survey_id, insight_hash, time_window) DO UPDATE SET
             headline    = EXCLUDED.headline,
             narrative   = EXCLUDED.narrative,
             metric_json = EXCLUDED.metric_json,
             citations_json = EXCLUDED.citations_json,
             trust_score = EXCLUDED.trust_score,
             trust_json  = EXCLUDED.trust_json,
             priority    = EXCLUDED.priority,
             audit_json  = EXCLUDED.audit_json,
             superseded_at = NULL,
             generated_at  = NOW()""",
        (
            survey_id, org_id, run_id,
            ins["layer"], ins["category"],
            ins["headline"], ins["narrative"],
            json.dumps(ins.get("recommended_action")),
            json.dumps(ins.get("metric_json")),
            json.dumps(ins.get("citations_json", [])),
            ins["trust_score"],
            json.dumps(ins.get("trust_json", {})),
            ins["priority"],
            insight_hash,
            json.dumps(audit_json),
            json.dumps(user_state),
            time_window,
        ),
    )


# ── Node: report_agent (tiered narrative report) ─────────────────────────────

async def node_report_agent(state: dict) -> dict:
    """Generate a tier-appropriate narrative report using pre-computed topic signals.

    Runs AFTER node_narrate so Track 1 (metric-based) insights are in state.
    node_merge_tracks then fuses Track 1 + Track 2 before verify/evaluate/publish.

    Skips if:
    - Survey has no open-text questions (score-only surveys)
    - No topic_signals in state (node_topics didn't run or found no topics)
    - Not enough responses for minimum tier threshold (< 10)
    - Delta threshold not met (< REPORT_REGEN_MIN_NEW_RESPONSES new responses
      since last report) unless force_regenerate=True or trigger='manual'
    - Insights from cache and no force_regenerate
    """
    run_id = state["run_id"]
    await _update_heartbeat(run_id)

    # Skip for score-only surveys
    if not state.get("has_open_text"):
        logger.info("node_report_agent_skipped_no_text", survey_id=state.get("survey_id"))
        await _emit_event(run_id, "node_complete", "report_agent", {"skipped": "no_open_text"})
        return state

    # Skip if topic signals not computed (topics node skipped or insufficient clusters)
    if not state.get("topic_signals"):
        await _emit_event(run_id, "node_complete", "report_agent", {"skipped": "no_topic_signals"})
        return state

    # Skip if insights came from cache and no new responses
    if state.get("insights_from_cache") and not state.get("force_regenerate"):
        await _emit_event(run_id, "node_complete", "report_agent", {"skipped": "cache_hit"})
        return state

    try:
        report_insights = await run_tiered_report_agent(state)
    except Exception as exc:
        logger.error("node_report_agent_failed", run_id=run_id, error=str(exc), traceback=traceback.format_exc())
        await _emit_event(run_id, "node_complete", "report_agent", {"error": str(exc)})
        return state

    if not report_insights:
        await _emit_event(run_id, "node_complete", "report_agent", {"insight_count": 0})
        return state

    # Determine the tier that was generated for logging
    metrics = state.get("metrics", {})
    total   = metrics.get("total_responses", 0)
    if total < 40:
        tier = "headline"
    elif total < 70:
        tier = "summary"
    else:
        tier = "full_report"

    existing_insights = list(state.get("insights") or [])
    combined = existing_insights + report_insights

    await _emit_event(run_id, "node_complete", "report_agent", {
        "tier": tier,
        "report_insight_count": len(report_insights),
        "total_insight_count":  len(combined),
    })

    return {**state, "insights": combined}


# ── Node: merge_tracks (dedup Track 1 + Track 2) ──────────────────────────────

def _normalize_topic_name(name: str) -> str:
    """Stable key for topic name comparison — lowercase, no punctuation, sorted words."""
    import re as _re
    words = sorted(_re.sub(r"[^a-z0-9 ]", "", name.lower()).split())
    return " ".join(words)


async def node_merge_tracks(state: dict) -> dict:
    """Merge Track 1 (metric-based) and Track 2 (narrative report) insights.

    Track 1 (voice.topic) insights have rich NPS-driver signals.
    Track 2 (report.*_theme) insights have grounded verbatim quotes and narrative depth.
    Rather than publishing two cards about the same topic, we enrich the Track 1
    insight with Track 2's grounded citations and drop the Track 2 duplicate.

    Structural Track 2 insights that have no Track 1 counterpart are kept as-is:
      - report.executive_summary  → unique high-level overview
      - report.summary_overview   → same
      - report.priority_action    → cross-theme prescriptive (no Track 1 analogue)
      - report.*_theme with no matching voice.topic → kept (new theme only found by report)
    """
    run_id   = state["run_id"]
    insights = list(state.get("insights") or [])

    # Build index of Track 1 topic insights by normalized name
    track1_by_topic: dict[str, int] = {}   # normalized_name → index in insights list
    for idx, ins in enumerate(insights):
        if ins.get("category") == "voice.topic":
            topic_name = (ins.get("metric_json") or {}).get("topic") or ins.get("headline", "")
            key = _normalize_topic_name(topic_name)
            if key:
                track1_by_topic[key] = idx

    # Structural report categories always kept (no Track 1 counterpart)
    _KEEP_AS_IS = {
        "report.executive_summary",
        "report.summary_overview",
        "report.priority_action",
    }

    merged_insights: list[dict] = list(insights)
    indices_to_drop: list[int] = []
    merges = 0

    for idx, ins in enumerate(insights):
        category = ins.get("category", "")
        if not category.startswith("report."):
            continue
        if category in _KEEP_AS_IS:
            continue

        # This is a report.*_theme insight — try to match it to a voice.topic
        theme_name = (ins.get("metric_json") or {}).get("theme") or ins.get("headline", "")
        key = _normalize_topic_name(theme_name)
        track1_idx = track1_by_topic.get(key)

        if track1_idx is not None:
            # Found a matching voice.topic — enrich it with Track 2's grounded citations
            t1 = merged_insights[track1_idx]
            existing_quotes = {c.get("quote", "") for c in (t1.get("citations_json") or [])}
            new_citations = [
                c for c in (ins.get("citations_json") or [])
                if c.get("quote") and c["quote"] not in existing_quotes
            ]
            if new_citations:
                merged_insights[track1_idx] = {
                    **t1,
                    "citations_json": (t1.get("citations_json") or []) + new_citations[:3],
                }
            # Boost trust slightly since we now have two independent sources agreeing
            cur_trust = merged_insights[track1_idx].get("trust_score", 60)
            merged_insights[track1_idx]["trust_score"] = min(95, cur_trust + 3)

            # Also inherit business_impact / root_cause if Track 2 has them and Track 1 doesn't
            t1_meta = merged_insights[track1_idx].get("metric_json") or {}
            t2_meta = ins.get("metric_json") or {}
            if not t1_meta.get("business_impact") and t2_meta.get("business_impact"):
                new_meta = {**t1_meta, "business_impact": t2_meta["business_impact"]}
                if t2_meta.get("root_cause_hypothesis"):
                    new_meta["root_cause_hypothesis"] = t2_meta["root_cause_hypothesis"]
                merged_insights[track1_idx] = {**merged_insights[track1_idx], "metric_json": new_meta}

            # Schedule Track 2 duplicate for removal
            indices_to_drop.append(idx)
            merges += 1
        # else: Track 2 found a topic not in Track 1 — keep it (new theme)

    # Remove duplicates (highest index first to preserve lower indices)
    for idx in sorted(set(indices_to_drop), reverse=True):
        if 0 <= idx < len(merged_insights):
            merged_insights.pop(idx)

    await _emit_event(run_id, "node_complete", "merge_tracks", {
        "total_insights":  len(merged_insights),
        "merged":          merges,
        "dropped":         len(indices_to_drop),
    })
    logger.info(
        "node_merge_tracks_done",
        merged=merges,
        dropped=len(indices_to_drop),
        remaining=len(merged_insights),
    )
    return {**state, "insights": merged_insights}


# ── Build the graph ───────────────────────────────────────────────────────────

def build_insight_graph():
    """Construct and compile the insight generation LangGraph.

    Pipeline:
      ingest → context → route_specialists → embed → [metrics + extract_texts] → absa → cluster
            → topics → narrate → report_agent → merge_tracks → verify → evaluate → publish

    narrate:      Track 1 — metric-based expert insights (NPS, CSAT, Topic, Trend, Prescriptive).
    report_agent: Track 2 — tier-routed narrative report driven by topic_signals.
                  headline (10-39), summary (40-69), full_report (70+).
    merge_tracks: Fuses Track 1 + Track 2: enriches voice.topic with Track 2 verbatims,
                  drops Track 2 duplicates of topics already covered by Track 1.
    verify:       Per-insight hallucination check against citation quotes.
    evaluate:     Holistic quality audit (coverage, balance, actionability, redundancy).
    publish:      DB upsert + per-window metric snapshots.
    ai_triggers:  Xperiq Actions Wave 3 — detects sentiment_spike/new_theme_detected/
                  anomaly_detected from already-published state and emits `workflow_signal`
                  events to the backend for any that pass threshold + hysteresis.
    """
    g = StateGraph(InsightState)
    g.add_node("resolve_context",   node_resolve_context)
    g.add_node("ingest",            node_ingest)
    g.add_node("context",           node_context)
    g.add_node("route_specialists", node_route_specialists)
    g.add_node("embed",             node_embed)
    g.add_node("metrics",           node_metrics)
    g.add_node("extract_texts",     node_extract_texts)
    g.add_node("absa",              node_absa)
    g.add_node("cluster",           node_cluster)
    g.add_node("topics",            node_topics)
    g.add_node("delta_compute",      node_delta_compute)
    g.add_node("narrate",            node_narrate)
    g.add_node("report_agent",       node_report_agent)
    g.add_node("merge_tracks",       node_merge_tracks)
    g.add_node("verify",             node_verify)
    g.add_node("evaluate",           node_evaluate)
    g.add_node("publish",            node_publish)
    g.add_node("ai_triggers",        node_ai_triggers)

    g.set_entry_point("resolve_context")
    g.add_edge("resolve_context",    "ingest")
    g.add_edge("ingest",             "context")
    g.add_edge("context",            "route_specialists")
    g.add_edge("route_specialists",  "embed")
    g.add_edge("embed",              "metrics")
    g.add_edge("embed",              "extract_texts")
    g.add_edge("metrics",            "absa")
    g.add_edge("extract_texts",      "absa")
    g.add_edge("absa",               "cluster")
    g.add_edge("cluster",            "topics")
    g.add_edge("topics",             "delta_compute")
    g.add_edge("delta_compute",      "narrate")
    g.add_edge("narrate",            "report_agent")
    g.add_edge("report_agent",       "merge_tracks")
    g.add_edge("merge_tracks",       "verify")
    g.add_edge("verify",             "evaluate")
    g.add_edge("evaluate",           "publish")
    g.add_edge("publish",            "ai_triggers")
    g.add_edge("ai_triggers",        END)

    return g.compile()


# ── Public API ────────────────────────────────────────────────────────────────

_insight_graph = None


def get_insight_graph():
    global _insight_graph
    if _insight_graph is None:
        _insight_graph = build_insight_graph()
    return _insight_graph


def _derive_profile(trigger: str, profile: str | None) -> str:
    """Derive run profile from explicit arg or trigger (backward compatible).

    Explicit profile wins. Otherwise: trigger='manual' → manual_quick (legacy UI
    Refresh maps to a quick manual run); trigger='refresh' → refresh; everything
    else (stream/scheduler/milestone/api/schedule) → automated_incremental.
    """
    if profile:
        return profile
    if trigger == "refresh":
        return INSIGHT_PROFILE_REFRESH
    # Legacy: trigger='manual' historically meant "force regenerate the automated
    # projection" (UI Refresh), NOT a manual report. Keep that behavior — it stays
    # automated_incremental with force_regenerate=True so existing callers are
    # unchanged. Manual report runs pass profile= explicitly.
    return INSIGHT_PROFILE_AUTOMATED


async def run_insight_generation(
    survey_id: str,
    org_id: str,
    run_id: str,
    trigger: str = "schedule",
    *,
    profile: str | None = None,
    window_start=None,
    window_end=None,
    parent_checkpoint_id: str | None = None,
    config_override: dict | None = None,
    actor: str | None = None,
) -> dict:
    """Run the full insight generation pipeline.

    Backward compatible: existing callers pass only (survey_id, org_id, run_id,
    trigger). New v2 callers may pass profile (automated_incremental | refresh |
    manual_expert | manual_quick), a manual window, an explicit parent checkpoint,
    a config_override merged into settings, and an actor string for lineage.
    """
    # Set trace context HERE, before ainvoke, so all LangGraph node-tasks
    # inherit the correct run_id/org_id when they are created by the graph runner.
    # Setting it only inside node_ingest is too late — LangGraph creates a new
    # asyncio Task per node, and each task copies the context at creation time.
    from crystalos.lib.trace_context import set_trace_context
    set_trace_context(run_id=run_id, org_id=org_id)
    structlog.contextvars.bind_contextvars(run_id=run_id, org_id=org_id)

    resolved_profile = _derive_profile(trigger, profile)
    # force_regenerate: manual/refresh always regenerate; legacy trigger='manual'
    # also forces. Automated stream/scheduler use cache when data is unchanged.
    force_regen = (
        trigger == "manual"
        or resolved_profile in (INSIGHT_PROFILE_REFRESH, INSIGHT_PROFILE_MANUAL_EXPERT,
                                INSIGHT_PROFILE_MANUAL_QUICK)
    )
    _actor = actor or (
        "user:unknown" if resolved_profile in _MANUAL_PROFILES else f"system:{trigger}"
    )

    graph = get_insight_graph()
    initial_state = {
        "survey_id": survey_id, "org_id": org_id,
        "run_id": run_id, "trigger": trigger,
        # Manual trigger (UI Refresh button) forces full re-narration even if data unchanged.
        # Scheduler/stream/bulk triggers use cached insights when data is identical.
        "force_regenerate": force_regen,
        # Insight Pipeline v2 — profile + manual params consumed by resolve_context.
        "profile":              resolved_profile,
        "actor":                _actor,
        "window_start":         window_start,
        "window_end":           window_end,
        "parent_checkpoint_id": parent_checkpoint_id or "",
        "config_override":      config_override or {},
        "survey_settings":      {},
        "parent_checkpoint":    None,
        "prior_checkpoints":    [],
        "watermark":            None,
        "metric_snapshots":     [],
        "config_hash":          "",
        "sample_ids":           set(),
        "sample_stats":         {},
        "skip_run":             False,
        "skip_reason":          "",
        "skip_report":          False,
        "report_id":            (config_override or {}).get("report_id", "") if config_override else "",
        "survey": {}, "responses": [],
        "new_response_ids": set(),
        "metrics": {}, "open_texts": [],
        "embedded_texts": [],
        "absa_results": [], "clusters": [],
        "topics": [],
        "topic_signals": {},
        "drivers": [], "stream_events": [],
        "insights": [], "errors": [],
        "insights_from_cache": False,
        "narrate_attempt":      0,
        "prior_snapshots":      [],
        "prior_insights":       [],   # populated by node_narrate, consumed by node_report_agent
        "prior_context_run_id": "",   # run_id of the anchor; written to agent_runs in node_publish
        # Phase 0.5 — populated by node_delta_compute, consumed by node_narrate + node_publish
        "delta_from_prior":     None,
        "meaningful_delta":     True,
        "prior_checkpoint_summaries": [],
        "last_report_response_count": 0,
        "org_context":          {},
        "survey_context":       {},
        "selected_specialists": [],
        "has_open_text":        True,
        "has_nps":              False,
        "has_csat":             False,
        "has_ces":              False,
        "survey_questions":     [],
    }
    try:
        result = await graph.ainvoke(initial_state)
        return result
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        import traceback as _tb
        logger.error(
            "insight_generation_failed",
            run_id=run_id, org_id=org_id, survey_id=survey_id,
            error=str(exc), traceback=_tb.format_exc(),
        )
        try:
            await db.update_run(run_id, status="failed", error_log=[str(exc)])
        except Exception:
            pass
        raise
