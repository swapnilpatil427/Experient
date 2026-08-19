"""Custom Analysis — fully isolated insight graph (Insight Pipeline v2, Phase 6).

Custom Analysis lets users select a date range, segments, and topic scope and
generate a targeted, ad-hoc report. It is architecturally separated from the main
insight pipeline (03 §10/§11):

HARD ISOLATION INVARIANTS (enforced here):
  1. NEVER writes the ``insights`` table — only ``custom_report_insights``.
  2. NEVER supersedes (no ``superseded_at`` writes anywhere).
  3. NEVER mutates ``survey_topics`` centroids — topic discovery runs read-only
     (``discover_topics`` only; ``upsert_survey_topics`` is never called).
  4. trust_score is capped at 55 when the filtered corpus has n < 30.
  5. No predictive-layer insights (population continuity not guaranteed for a
     filtered subset).

This is an isolated graph in spirit: it reuses the shared computational tool
functions (metrics, ABSA, clustering, topic discovery, narration) but composes
them in its own linear flow that writes to the isolated tables. It never invokes
``node_publish`` / ``node_topics`` / the LangGraph automated pipeline.

Entry point:
    run_custom_analysis(survey_id, org_id, run_id, custom_report_id, filter_spec, actor)

Triggered via ``POST /reports/custom/run`` (main.py, X-Internal-Key secured).
"""
from __future__ import annotations

import json
import time
import traceback
from datetime import datetime, timezone
from typing import Any

from crystalos.lib import db
from crystalos.lib.logger import logger
from crystalos.lib.checkpoint_store import write_checkpoint_blob
from crystalos.lib.openrouter import call_agent
from crystalos.tools.metrics import (
    compute_nps_ci, compute_csat, compute_ces, compute_completion_rate,
    extract_open_texts, compute_effort_score,
)
from crystalos.tools.embeddings import get_or_create_embeddings
from crystalos.tools.clustering import cluster_texts
from crystalos.tools.sentiment import run_absa_llm
from crystalos.tools.topics import discover_topics


# Minimum n below which the NPS metric is statistically degraded → trust cap (03 §11).
CUSTOM_MIN_N_FOR_NPS_DEFAULT = 30
TRUST_CAP_BELOW_MIN_N = 55


async def _absa_llm_func(prompt: str) -> str:
    """Raw LLM call for ABSA batches (mirrors graphs/insights._llm_raw).

    Uses the insight_narrate model config; json_mode=False because ABSA prompts
    request a top-level JSON array. run_absa_llm falls back to heuristics on error.
    """
    from crystalos.lib.openrouter import _retry_loop
    from crystalos.lib.models import ModelConfig, get_model
    base = get_model("insight_narrate")
    config = ModelConfig(
        model=base.model, max_tokens=2500, temperature=0.0,
        use_anthropic_sdk=base.use_anthropic_sdk,
    )
    content, _usage = await _retry_loop(
        [{"role": "user", "content": prompt}], config, json_mode=False,
    )
    return content


# ── Filter application ─────────────────────────────────────────────────────────

def _as_dt(val: Any) -> datetime | None:
    if isinstance(val, datetime):
        return val if val.tzinfo else val.replace(tzinfo=timezone.utc)
    if isinstance(val, str) and val:
        try:
            return datetime.fromisoformat(val.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _answer_value_for(answers: list, field: str) -> str | None:
    """Resolve a segment value from a response's answers by questionId/field."""
    for a in (answers or []):
        if not isinstance(a, dict):
            continue
        qid = a.get("questionId") or a.get("question_id")
        if str(qid) == str(field):
            return str(a.get("value")) if a.get("value") is not None else None
    return None


def apply_filter_spec(rows: list[dict], filter_spec: dict) -> list[dict]:
    """Filter response rows by the custom-analysis filter_spec (03 §10).

    filter_spec keys (all optional):
      date_from / date_to   — ISO8601 window on submitted_at
      segments              — [{"field": questionId, "op": "eq", "value": ...}]
      topics                — [topic name] (matched against ai_topics)
      metric_types          — informational; corpus is not narrowed by metric
      narrative_depth       — "summary" | "detailed" (consumed at narrate time)

    Pure function over loaded rows — deterministic + unit-testable without a DB.
    """
    spec = filter_spec or {}
    df = _as_dt(spec.get("date_from"))
    dt_to = _as_dt(spec.get("date_to"))
    segments = spec.get("segments") or []
    topics = [str(t).lower() for t in (spec.get("topics") or [])]

    out: list[dict] = []
    for r in rows:
        # ── Date window (submitted_at) ────────────────────────────────────────
        sub = _as_dt(r.get("submitted_at"))
        if df is not None and (sub is None or sub < df):
            continue
        if dt_to is not None and (sub is None or sub > dt_to):
            continue

        # ── Segment filters (eq / ne / in) ────────────────────────────────────
        answers = r.get("answers") or []
        if isinstance(answers, str):
            try:
                answers = json.loads(answers)
            except Exception:
                answers = []
        seg_ok = True
        for seg in segments:
            if not isinstance(seg, dict):
                continue
            field = seg.get("field")
            op = (seg.get("op") or "eq").lower()
            want = seg.get("value")
            have = _answer_value_for(answers, field)
            if op == "eq":
                seg_ok = have is not None and have == str(want)
            elif op == "ne":
                seg_ok = have != str(want)
            elif op == "in":
                vals = {str(v) for v in (want or [])}
                seg_ok = have is not None and have in vals
            if not seg_ok:
                break
        if not seg_ok:
            continue

        # ── Topic filter (ai_topics contains any requested topic) ──────────────
        if topics:
            ai_topics = r.get("ai_topics") or []
            if isinstance(ai_topics, str):
                ai_topics_l = ai_topics.lower()
                if not any(t in ai_topics_l for t in topics):
                    continue
            else:
                names = {str(x).lower() for x in ai_topics}
                if not any(t in n for t in topics for n in names):
                    continue

        out.append(r)
    return out


def _resolve_credit_cost_for_corpus(corpus_size: int) -> int:
    """Tiered custom-analysis credit cost (05 §7): ≤500=25, ≤2000=50, >2000=75."""
    if corpus_size <= 500:
        return 25
    if corpus_size <= 2000:
        return 50
    return 75


def _cap_trust(score: int, below_min_n: bool) -> int:
    """Cap trust at 55 when n < min (03 §11 invariant 3)."""
    score = int(score)
    if below_min_n:
        return min(score, TRUST_CAP_BELOW_MIN_N)
    return score


# ── Corpus loading (read-only) ─────────────────────────────────────────────────

async def _load_survey(survey_id: str, org_id: str) -> dict | None:
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT id, title, questions FROM surveys WHERE id = %s AND org_id = %s AND deleted_at IS NULL",
                    (survey_id, org_id),
                )
                row = await cur.fetchone()
                if not row:
                    return None
                return dict(zip([d[0] for d in cur.description], row))
    except Exception as exc:
        logger.warning("custom_analysis_load_survey_failed", survey_id=survey_id, error=str(exc))
        return None


async def _load_corpus(survey_id: str, org_id: str, cap: int) -> list[dict]:
    """Load up to ``cap`` response rows (read-only) for filtering + analysis.

    Loads the full set (capped) so apply_filter_spec runs in Python; the caller
    then samples down to custom_analysis_max_corpus if still over cap.
    """
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT id, answers, submitted_at,
                              ai_enriched_at, ai_sentiment, ai_sentiment_score,
                              ai_emotion, ai_effort_score, nps_score, ai_topics
                       FROM responses
                       WHERE survey_id = %s AND org_id = %s AND deleted_at IS NULL
                       ORDER BY submitted_at DESC NULLS LAST
                       LIMIT %s""",
                    (survey_id, org_id, cap),
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, r)) for r in rows]
    except Exception as exc:
        logger.warning("custom_analysis_load_corpus_failed", survey_id=survey_id, error=str(exc))
        return []


# ── Status helpers (write only to custom_reports — never insights) ─────────────

async def _update_custom_report(custom_report_id: str, **fields) -> None:
    """UPDATE a custom_reports row. Only touches custom_reports. Never raises."""
    if not fields:
        return
    cols = ", ".join(f"{k} = %s" for k in fields)
    args = list(fields.values()) + [custom_report_id]
    try:
        async with db._pool_conn().connection() as conn:
            await conn.execute(
                f"UPDATE custom_reports SET {cols} WHERE id = %s",  # noqa: S608 - keys are code constants
                args,
            )
    except Exception as exc:
        logger.warning("custom_report_update_failed", custom_report_id=custom_report_id, error=str(exc))



# HARD INVARIANT: Custom Analysis has no predictive layer — only descriptive +
# diagnostic insights are ever allowed. This was previously enforced only by
# omission (no forecasting tool is imported into this module) with no runtime
# guard that would catch a future accidental "predictive" emission. Checked
# here, at the one place every insight is written, rather than left as an
# assumption a future change to _build_custom_insights could silently violate.
_ALLOWED_CUSTOM_INSIGHT_LAYERS = frozenset({"descriptive", "diagnostic"})


async def _insert_custom_insight(
    custom_report_id: str, org_id: str, survey_id: str, ins: dict, filter_label: str,
) -> None:
    """INSERT one custom_report_insights row. NEVER writes the insights table.

    Immutable snapshot — no superseded_at, no ON CONFLICT update.
    """
    if ins.get("layer") not in _ALLOWED_CUSTOM_INSIGHT_LAYERS:
        logger.error(
            "custom_insight_invalid_layer_blocked",
            custom_report_id=custom_report_id,
            layer=ins.get("layer"),
            category=ins.get("category"),
        )
        return
    try:
        async with db._pool_conn().connection() as conn:
            await conn.execute(
                """INSERT INTO custom_report_insights
                     (custom_report_id, org_id, survey_id, layer, category,
                      headline, narrative, metric_json, citations_json,
                      trust_score, trust_json, priority, filter_label)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    custom_report_id, org_id, survey_id,
                    ins["layer"], ins["category"],
                    ins["headline"], ins.get("narrative", ""),
                    json.dumps(ins.get("metric_json", {})),
                    json.dumps(ins.get("citations_json", [])),
                    int(ins.get("trust_score", 50)),
                    json.dumps(ins.get("trust_json", {})),
                    ins.get("priority"),
                    filter_label,
                ),
            )
    except Exception as exc:
        logger.warning("custom_insight_insert_failed", custom_report_id=custom_report_id, error=str(exc))


def _filter_label(filter_spec: dict) -> str:
    """Human-readable label for the filter that produced these insights."""
    spec = filter_spec or {}
    parts: list[str] = []
    segs = spec.get("segments") or []
    for s in segs[:2]:
        if isinstance(s, dict) and s.get("value") is not None:
            parts.append(str(s["value"]))
    topics = spec.get("topics") or []
    if topics:
        parts.append(", ".join(str(t) for t in topics[:2]))
    df, dt_to = spec.get("date_from"), spec.get("date_to")
    if df or dt_to:
        parts.append(f"{(df or '')[:10]}–{(dt_to or '')[:10]}")
    return " / ".join(parts) or "All responses"


# ── Main entry point ────────────────────────────────────────────────────────────

async def run_custom_analysis(
    survey_id: str,
    org_id: str,
    run_id: str,
    custom_report_id: str,
    filter_spec: dict,
    actor: str | None = None,
) -> dict:
    """Run a fully-isolated custom analysis and write custom_report_insights.

    Writes ONLY to custom_reports + custom_report_insights (+ a blob). It never
    touches the insights table, never supersedes, and never mutates survey_topics.

    Returns {custom_report_id, status, sample_size, trust_score_avg, output_url}.
    """
    started = time.monotonic()
    filter_spec = filter_spec or {}
    label = _filter_label(filter_spec)

    survey = await _load_survey(survey_id, org_id)
    if not survey:
        await _update_custom_report(custom_report_id, status="failed",
                                    completed_at=datetime.now(timezone.utc))
        return {"custom_report_id": custom_report_id, "status": "failed",
                "error": "survey not found"}

    await _update_custom_report(custom_report_id, status="running", run_id=run_id)

    # ── Settings (caps) ───────────────────────────────────────────────────────
    try:
        from crystalos.lib.insight_settings import load_insight_settings
        settings = await load_insight_settings(survey_id, org_id)
    except Exception:
        settings = {}
    max_corpus = int(settings.get("custom_analysis_max_corpus", 5000) or 5000)
    min_n_for_nps = int(settings.get("custom_analysis_min_n_for_nps", CUSTOM_MIN_N_FOR_NPS_DEFAULT)
                        or CUSTOM_MIN_N_FOR_NPS_DEFAULT)

    questions = survey.get("questions") or []
    if isinstance(questions, str):
        try:
            questions = json.loads(questions)
        except Exception:
            questions = []

    try:
        # ── Load + filter corpus (read-only) ──────────────────────────────────
        # Load up to a hard ceiling (2× max_corpus) so the filter sees enough rows.
        raw_rows = await _load_corpus(survey_id, org_id, cap=max_corpus * 2)
        total_matching = 0
        filtered = apply_filter_spec(raw_rows, filter_spec)
        total_matching = len(filtered)

        # ── Cap per custom_analysis_max_corpus with sampling ──────────────────
        if len(filtered) > max_corpus:
            from crystalos.tools.sampling import stratified_sample
            keep_ids = set(stratified_sample(filtered, max_corpus))
            filtered = [r for r in filtered if str(r.get("id")) in keep_ids]

        sample_size = len(filtered)
        coverage_pct = round((sample_size / total_matching) * 100, 2) if total_matching else 0.0

        # ── Normalize metric signals from answers (no DB write) ───────────────
        for r in filtered:
            answers = r.get("answers") or []
            if isinstance(answers, str):
                try:
                    answers = json.loads(answers)
                except Exception:
                    answers = []
            r["answers"] = answers
            for a in answers:
                q = next((q for q in questions if q.get("id") == a.get("questionId")), None)
                if not q:
                    continue
                qt = q.get("type")
                try:
                    if qt == "nps":
                        r["nps_score"] = int(a["value"])
                    elif qt == "csat":
                        r["csat_score"] = float(a["value"])
                    elif qt == "ces":
                        r["ces_score"] = float(a["value"])
                except (ValueError, TypeError, KeyError):
                    pass

        below_min_n = sample_size < min_n_for_nps

        # ── Metrics (reuse computational tools) ───────────────────────────────
        metrics: dict[str, Any] = {"total_responses": sample_size}
        if any(r.get("nps_score") is not None for r in filtered):
            metrics["nps"] = compute_nps_ci(filtered)
        if any(r.get("csat_score") is not None for r in filtered):
            metrics["csat"] = compute_csat(filtered)
        if any(r.get("ces_score") is not None for r in filtered):
            metrics["ces"] = compute_ces(filtered)
        metrics["completion"] = compute_completion_rate(filtered)

        # ── Open texts → embed → ABSA → cluster → topic discovery (read-only) ──
        topics: list[dict] = []
        try:
            raw_texts = extract_open_texts(filtered, questions)
            if raw_texts:
                metrics["effort_score"] = compute_effort_score([t["text"] for t in raw_texts])
                tagged = [{**t, "org_id": org_id, "survey_id": survey_id} for t in raw_texts]
                try:
                    async with db._pool_conn().connection() as conn:
                        embedded = await get_or_create_embeddings(tagged, conn)
                except Exception:
                    embedded = raw_texts
                # ABSA only when we have a meaningful number of texts. run_absa_llm
                # falls back to heuristics per-batch on LLM failure, so this never
                # crashes the analysis.
                absa_results: list[dict] = []
                if len(embedded) >= 3:
                    try:
                        absa_results = await run_absa_llm(
                            embedded, _absa_llm_func,
                            survey_context=survey.get("title", ""),
                        ) or []
                    except Exception as exc:
                        logger.debug("custom_analysis_absa_failed", error=str(exc))
                        absa_results = embedded
                cluster_input = absa_results or embedded
                clusters = cluster_texts(cluster_input) if cluster_input else []
                if clusters:
                    # Topic discovery is READ-ONLY — discover_topics never touches
                    # survey_topics. We deliberately do NOT call upsert_survey_topics.
                    topic_items = await discover_topics(
                        clusters, previous_topic_names=[], call_agent_func=call_agent,
                        survey_title=survey.get("title", ""),
                    )
                    topics = [
                        {"name": ti.name, "volume": ti.volume,
                         "sentiment_score": ti.sentiment_score,
                         "summary": ti.summary, "effort_score": ti.effort_score}
                        for ti in topic_items
                    ]
        except Exception as exc:
            logger.warning("custom_analysis_text_pipeline_failed", error=str(exc))

        # ── Build insights (descriptive + diagnostic only — NO predictive) ────
        insights = _build_custom_insights(metrics, topics, sample_size, below_min_n, label)

        # Filter to the allowed layers BEFORE anything downstream (DB insert,
        # trust_avg, blob, completion log) touches `insights`, so a future
        # accidental predictive/other-layer emission from _build_custom_insights
        # can't make the report blob/summary/status claim more than what's
        # actually persisted in custom_report_insights. _insert_custom_insight's
        # own per-row guard stays as defense-in-depth; this is the primary gate.
        rejected = [i for i in insights if i.get("layer") not in _ALLOWED_CUSTOM_INSIGHT_LAYERS]
        if rejected:
            logger.error(
                "custom_analysis_insights_filtered_invalid_layer",
                custom_report_id=custom_report_id,
                rejected_layers=[i.get("layer") for i in rejected],
            )
        insights = [i for i in insights if i.get("layer") in _ALLOWED_CUSTOM_INSIGHT_LAYERS]

        # ── Persist insights to custom_report_insights ONLY ───────────────────
        for ins in insights:
            await _insert_custom_insight(custom_report_id, org_id, survey_id, ins, label)

        trust_scores = [i["trust_score"] for i in insights if i.get("trust_score") is not None]
        trust_avg = round(sum(trust_scores) / len(trust_scores), 1) if trust_scores else None

        # ── Write report blob (isolated; checkpoint_store, custom prefix) ──────
        blob = {
            "schema_version": 2,
            "kind": "custom_analysis",
            "survey_id": survey_id,
            "org_id": org_id,
            "custom_report_id": custom_report_id,
            "filter_spec": filter_spec,
            "filter_label": label,
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "sample_size": sample_size,
            "corpus_coverage_pct": coverage_pct,
            "metrics": metrics,
            "topics": topics[:40],
            "insights": insights,
        }
        blob_ref = None
        try:
            blob_ref = await write_checkpoint_blob(blob, org_id, survey_id, f"custom-{custom_report_id}")
        except Exception as exc:
            logger.warning("custom_analysis_blob_failed", error=str(exc))

        slug = f"cr-{str(custom_report_id)[:8]}-{int(time.time())}"
        output_url = f"/reports/custom/{slug}"
        credit_cost = _resolve_credit_cost_for_corpus(sample_size)

        await _update_custom_report(
            custom_report_id,
            status="completed",
            blob_ref=blob_ref,
            output_url=output_url,
            slug=slug,
            credit_cost=credit_cost,
            corpus_coverage_pct=coverage_pct,
            sample_size=sample_size,
            trust_score_avg=trust_avg,
            completed_at=datetime.now(timezone.utc),
        )

        # Mark the agent_runs row complete (audit), if present.
        try:
            async with db._pool_conn().connection() as conn:
                await conn.execute(
                    "UPDATE agent_runs SET status='completed', completed_at=NOW() WHERE id=%s",
                    (run_id,),
                )
        except Exception as exc:
            logger.warning("custom_analysis_agent_run_audit_update_failed", run_id=run_id, error=str(exc))

        logger.info(
            "custom_analysis_done",
            custom_report_id=custom_report_id, survey_id=survey_id,
            sample_size=sample_size, coverage_pct=coverage_pct,
            insights=len(insights), trust_avg=trust_avg,
            below_min_n=below_min_n, ms=round((time.monotonic() - started) * 1000),
        )
        return {
            "custom_report_id": custom_report_id,
            "status": "completed",
            "sample_size": sample_size,
            "corpus_coverage_pct": coverage_pct,
            "trust_score_avg": trust_avg,
            "output_url": output_url,
            "slug": slug,
        }

    except Exception as exc:
        logger.error("custom_analysis_failed", custom_report_id=custom_report_id,
                     error=str(exc), traceback=traceback.format_exc())
        await _update_custom_report(custom_report_id, status="failed",
                                    completed_at=datetime.now(timezone.utc))
        try:
            async with db._pool_conn().connection() as conn:
                await conn.execute(
                    "UPDATE agent_runs SET status='failed', completed_at=NOW() WHERE id=%s",
                    (run_id,),
                )
        except Exception as audit_exc:
            logger.warning("custom_analysis_agent_run_audit_update_failed", run_id=run_id, error=str(audit_exc))
        return {"custom_report_id": custom_report_id, "status": "failed", "error": str(exc)}


def _build_custom_insights(
    metrics: dict, topics: list[dict], sample_size: int, below_min_n: bool, label: str,
) -> list[dict]:
    """Assemble custom-report insight rows. Descriptive + diagnostic ONLY.

    No predictive layer (03 §11 invariant 4 — population continuity not guaranteed
    for a filtered subset). trust_score capped at 55 when below_min_n.
    """
    insights: list[dict] = []

    def _stat_trust(n: int) -> int:
        if n >= 100:
            return 90
        if n >= 50:
            return 80
        if n >= 30:
            return 70
        return max(10, round(10 + (n / 30.0) * 60))

    base_trust = _cap_trust(_stat_trust(sample_size), below_min_n)
    trust_json = {"statistical": _stat_trust(sample_size), "sample_size": sample_size,
                  "below_minimum_sample": below_min_n, "filtered": True}

    nps = metrics.get("nps") or {}
    if nps.get("score") is not None:
        insights.append({
            "layer": "descriptive", "category": "metric.nps",
            "headline": f"NPS is {nps['score']:g} ({label})"[:160],
            "narrative": (
                f"For this filtered cohort ({label}), NPS is {nps['score']:g} "
                f"(n={nps.get('n', sample_size)})."
                + (" Sample is below the statistical minimum — interpret with caution."
                   if below_min_n else "")
            ),
            "metric_json": {"name": "NPS", "value": nps["score"], "n": nps.get("n"),
                            "ci_low": nps.get("ci_low"), "ci_high": nps.get("ci_high")},
            "citations_json": [],
            "trust_score": base_trust, "trust_json": trust_json, "priority": 0.9,
        })

    csat = metrics.get("csat") or {}
    if csat.get("score") is not None:
        insights.append({
            "layer": "descriptive", "category": "metric.csat",
            "headline": f"CSAT is {csat['score']:g}/5 ({label})"[:160],
            "narrative": f"CSAT for this cohort is {csat['score']:g}/5 (n={csat.get('n', sample_size)}).",
            "metric_json": {"name": "CSAT", "value": csat["score"], "n": csat.get("n"), "scale": 5},
            "citations_json": [],
            "trust_score": base_trust, "trust_json": trust_json, "priority": 0.85,
        })

    ces = metrics.get("ces") or {}
    if ces.get("score") is not None:
        insights.append({
            "layer": "descriptive", "category": "metric.ces",
            "headline": f"CES is {ces['score']:g} ({label})"[:160],
            "narrative": f"Customer Effort for this cohort is {ces['score']:g} (n={ces.get('n', sample_size)}).",
            "metric_json": {"name": "CES", "value": ces["score"], "n": ces.get("n")},
            "citations_json": [],
            "trust_score": base_trust, "trust_json": trust_json, "priority": 0.8,
        })

    # Diagnostic topic insights (read-only discovery output).
    for t in sorted(topics, key=lambda x: x.get("volume", 0), reverse=True)[:8]:
        t_trust = _cap_trust(min(85, 50 + int(t.get("volume", 0))), below_min_n)
        insights.append({
            "layer": "diagnostic", "category": "voice.topic",
            "headline": f"{t['name']} ({label})"[:160],
            "narrative": t.get("summary", ""),
            "metric_json": {"topic": t["name"], "volume": t.get("volume", 0),
                            "sentiment_score": t.get("sentiment_score"),
                            "effort_score": t.get("effort_score")},
            "citations_json": [],
            "trust_score": t_trust,
            "trust_json": {**trust_json, "volume": t.get("volume", 0)},
            "priority": 0.6,
        })

    return insights
