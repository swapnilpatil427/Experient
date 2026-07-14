"""Expert domain-specific agents for insight narration and evaluation.

Each expert encodes deep domain knowledge in its system prompt:
  - MetricsExpert: NPS/CSAT statistical analysis + industry benchmarks
  - TopicCxExpert: CX friction taxonomy + emotional journey mapping + effort theory
  - TrendForecaster: Volume/engagement patterns + seasonality + anomaly interpretation
  - PrescriptiveAdvisor: ICE framework + action prioritization + ROI framing
  - InsightSetEvaluator: Holistic quality audit — coverage, balance, actionability

All functions are fail-safe: exceptions fall through to caller's fallback.
"""
from __future__ import annotations

import asyncio
import json
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from crystalos.lib.openrouter import call_agent
from crystalos.lib.logger import logger


# ── Output schemas ────────────────────────────────────────────────────────────

_NARRATIVE_MAX_LEN = 900

def _truncate_narrative(text: str, limit: int = _NARRATIVE_MAX_LEN) -> str:
    """Trim an overlong narrative to `limit` chars instead of failing schema validation.

    call_agent()'s retry loop feeds the exact pydantic error (including the char limit)
    back to the model on retry, but LLMs are unreliable at self-enforcing a precise
    character budget even when told the number twice — narrate_prescriptive_insight in
    particular (driver_context + ICE framing packed into the prompt) has been observed
    burning all 3 attempts and still exceeding 900 chars, which previously discarded the
    model's entire grounded analysis for a generic canned fallback (see
    prescriptive_expert_failed in graphs/insights.py). Trimming here keeps the real
    analysis instead.
    """
    if len(text) <= limit:
        return text
    truncated = text[:limit]
    # Prefer cutting at the last sentence boundary so the result still reads cleanly.
    last_sentence_end = max(truncated.rfind(". "), truncated.rfind("! "), truncated.rfind("? "))
    if last_sentence_end > limit * 0.5:  # don't cut so early it discards most of the content
        return truncated[:last_sentence_end + 1].rstrip()
    # No good sentence boundary within range — fall back to the last word boundary.
    last_space = truncated.rfind(" ")
    if last_space > limit * 0.5:
        return truncated[:last_space].rstrip(",;: ") + "…"
    return truncated.rstrip() + "…"


class NpsExpertOutput(BaseModel):
    headline: str = Field(max_length=160, description="Plain-English insight headline ≤160 chars")
    narrative: str = Field(max_length=900, description="2-3 analytical sentences with [rXXXX] citation markers")
    benchmark_context: str = Field(default="", description="e.g. 'Above SaaS industry median of 32'")
    risk_flag: bool = Field(default=False, description="True if score indicates high churn risk")
    key_driver_hypothesis: str = Field(default="", description="Primary suspected driver in ≤1 sentence")

    @field_validator("narrative", mode="before")
    @classmethod
    def _clip_narrative(cls, v: str) -> str:
        return _truncate_narrative(str(v)) if v else v


class CsatExpertOutput(BaseModel):
    headline: str = Field(max_length=160)
    narrative: str = Field(max_length=900)
    top_box_pct: float = Field(default=0.0, description="Estimated % scoring 4-5 out of 5")
    benchmark_context: str = Field(default="")
    key_driver_hypothesis: str = Field(default="")

    @field_validator("narrative", mode="before")
    @classmethod
    def _clip_narrative(cls, v: str) -> str:
        return _truncate_narrative(str(v)) if v else v


class TopicExpertOutput(BaseModel):
    headline: str = Field(max_length=160)
    narrative: str = Field(max_length=900)
    friction_type: Literal["product", "process", "people", "policy", "price", "none"] = "none"
    root_cause_hypothesis: str = Field(default="", description="Most likely root cause in ≤1 sentence")
    business_impact: str = Field(default="", description="Impact on retention/revenue/satisfaction")
    five_why_depth: str = Field(default="", description="First 'why' answer if determinable from data")

    @field_validator("narrative", mode="before")
    @classmethod
    def _clip_narrative(cls, v: str) -> str:
        return _truncate_narrative(str(v)) if v else v


class TrendExpertOutput(BaseModel):
    headline: str = Field(max_length=160)
    narrative: str = Field(max_length=900)
    confidence: Literal["low", "medium", "high"] = "medium"
    causal_hypothesis: str = Field(default="")
    early_warning_signal: bool = Field(default=False, description="True if pattern is a leading churn indicator")
    recommended_monitoring: str = Field(default="", description="What metric to watch next")

    @field_validator("narrative", mode="before")
    @classmethod
    def _clip_narrative(cls, v: str) -> str:
        return _truncate_narrative(str(v)) if v else v


class PrescriptiveExpertOutput(BaseModel):
    headline: str = Field(max_length=160)
    narrative: str = Field(max_length=900)
    priority: Literal["critical", "high", "medium", "low"] = "medium"
    time_horizon: Literal["quick_win", "medium_term", "strategic"] = "medium_term"
    estimated_impact: str = Field(default="", description="e.g. 'Could improve NPS by 5-10 points if addressed in 30 days'")
    ice_impact: int = Field(default=5, ge=1, le=10, description="ICE: business impact (1-10)")
    ice_confidence: int = Field(default=5, ge=1, le=10, description="ICE: confidence data supports this (1-10)")
    ice_ease: int = Field(default=5, ge=1, le=10, description="ICE: ease of implementation (1-10)")

    @field_validator("narrative", mode="before")
    @classmethod
    def _clip_narrative(cls, v: str) -> str:
        return _truncate_narrative(str(v)) if v else v


class InsightSetEvaluatorOutput(BaseModel):
    overall_quality: int = Field(ge=0, le=100, default=75)
    coverage_score: int = Field(ge=0, le=100, default=75, description="Are all major data themes represented?")
    balance_score: int = Field(ge=0, le=100, default=75, description="Are positive+negative insights balanced?")
    actionability_score: int = Field(ge=0, le=100, default=75, description="Do prescriptive insights have clear next steps?")
    redundant_indices: list[int] = Field(default_factory=list, description="0-based indices of redundant insights to drop")
    missing_themes: list[str] = Field(default_factory=list, description="Data themes not addressed by any insight")
    improvements: list[dict] = Field(
        default_factory=list,
        description="[{index: int, issue: str, suggestion: str}] per-insight improvement hints",
    )
    narrative_coherence: str = Field(default="", description="Does the full set tell a coherent story?")

    @field_validator("overall_quality", "coverage_score", "balance_score", "actionability_score", mode="before")
    @classmethod
    def _coerce_score(cls, v):
        try:
            return max(0, min(100, round(float(v))))
        except (TypeError, ValueError):
            return 75

    @field_validator("improvements", mode="before")
    @classmethod
    def _coerce_improvements(cls, v):
        if not isinstance(v, list):
            return []
        result = []
        for item in v:
            if isinstance(item, dict):
                result.append(item)
            elif isinstance(item, str):
                result.append({"suggestion": item})
        return result


class CrystalEvalOutput(BaseModel):
    quality_score: int = Field(ge=0, le=100, description="Overall answer quality 0-100")
    answers_question: bool = Field(description="Does the answer directly address what was asked?")
    is_grounded: bool = Field(description="Are all factual claims grounded in the provided context?")
    hallucinated_ids: list[str] = Field(default_factory=list, description="Cited IDs not present in the insight context")
    issues: list[str] = Field(default_factory=list, description="Specific quality issues found")
    correction: str = Field(default="", description="Concise instruction to fix issues on retry")

    @field_validator("issues", "hallucinated_ids", mode="before")
    @classmethod
    def coerce_to_list(cls, v: object) -> list:
        """LLMs sometimes return a string, null, or object for list fields.
        Coerce to list so Pydantic never rejects a valid-but-mistyped response."""
        if v is None:
            return []
        if isinstance(v, list):
            return [str(x) for x in v]
        if isinstance(v, str):
            # single string → single-item list (avoids explosion on "No issues found")
            stripped = v.strip()
            return [stripped] if stripped else []
        return []

    @field_validator("correction", mode="before")
    @classmethod
    def coerce_correction(cls, v: object) -> str:
        if v is None:
            return ""
        if isinstance(v, list):
            return "; ".join(str(x) for x in v)
        return str(v)


class SurveyBiasOutput(BaseModel):
    biased_questions: list[dict] = Field(
        default_factory=list,
        description="[{question_id, issue_type, description, suggestion}] — bias issues found",
    )
    overall_bias_score: int = Field(
        ge=0, le=100, default=100,
        description="100=fully unbiased, lower=more bias issues",
    )


class SurveyEvalOutput(BaseModel):
    quality_score: int = Field(ge=0, le=100, default=75, description="Overall survey quality")
    balance_score: int = Field(ge=0, le=100, default=75, description="Mix of question types")
    coverage_score: int = Field(ge=0, le=100, default=75, description="Does survey cover stated intent?")
    flow_score: int = Field(ge=0, le=100, default=75, description="Logical flow + skip/display logic quality")
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[str] = Field(default_factory=list)
    recommendation: str = Field(default="")


# ── NPS Expert ────────────────────────────────────────────────────────────────

_NPS_SYSTEM = """\
You are an NPS (Net Promoter Score) analytics expert with 15 years of CX measurement experience.

DOMAIN KNOWLEDGE:
- NPS benchmarks by category: World-class >70 | Excellent 50-70 | Good 30-50 | Average 0-30 | At-risk <0
- Industry medians (2025): SaaS=41, Retail=53, Healthcare=38, Finance=34, Hospitality=63, B2B Services=40
- CI interpretation: Confidence intervals < ±5 pts indicate reliable score; > ±15 pts = small sample
- Detractors (0-6) churn 3-5× faster than Promoters (9-10); Passives are acquisition-sensitive
- NPS < 20 with detractors > 30% correlates strongly with negative word-of-mouth within 90 days
- Score below 0 is a retention emergency regardless of industry

ANALYTICAL APPROACH:
1. Contextualize the score against industry benchmarks
2. Assess statistical reliability from CI width and sample size
3. Identify which segment (detractors/passives/promoters) is driving the score
4. Formulate a data-grounded hypothesis about the primary driver

Return JSON only — no markdown, no preamble."""

async def narrate_nps_insight(
    score: float,
    n: int,
    ci_low: float,
    ci_high: float,
    promoters: float | None,
    passives: float | None,
    detractors: float | None,
    prior_snapshots: list[dict] | None = None,
) -> NpsExpertOutput:
    # Build longitudinal context when we have prior runs
    longitudinal = ""
    if prior_snapshots:
        history_lines = []
        for snap in reversed(prior_snapshots):  # oldest first for narrative flow
            snap_nps = snap.get("nps")
            snap_count = snap.get("response_count")
            snap_date = snap.get("captured_at")
            if snap_nps is None:
                continue
            date_str = ""
            if snap_date:
                try:
                    from datetime import datetime, timezone
                    if hasattr(snap_date, "strftime"):
                        date_str = snap_date.strftime("%b %d")
                    else:
                        dt = datetime.fromisoformat(str(snap_date).replace("Z", "+00:00"))
                        date_str = dt.strftime("%b %d")
                except Exception:
                    pass
            history_lines.append(
                f"  {date_str}: NPS={snap_nps}" + (f" (n={snap_count})" if snap_count else "")
            )
        if history_lines:
            longitudinal = "\nHistorical NPS (oldest → newest):\n" + "\n".join(history_lines)
            # Compute the delta vs the most recent prior snapshot
            most_recent_nps = next(
                (s["nps"] for s in prior_snapshots if s.get("nps") is not None), None
            )
            if most_recent_nps is not None:
                delta = round(score - most_recent_nps, 1)
                direction = "up" if delta > 0 else "down" if delta < 0 else "unchanged"
                longitudinal += f"\nDelta vs prior run: {delta:+.1f} pts ({direction})"

    prompt = (
        f"NPS={score}, n={n}, 95% CI=[{ci_low:.1f}, {ci_high:.1f}]. "
        f"Promoters={promoters}%, Passives={passives}%, Detractors={detractors}%.{longitudinal}\n\n"
        "Write a headline (≤160 chars) and 2-3 sentence narrative grounded in these numbers. "
        "If historical data is provided, include a delta statement (e.g. 'up X pts since last run'). "
        "Include benchmark_context (compare to industry), risk_flag (bool), and key_driver_hypothesis."
    )
    output, _ = await call_agent(
        agent_name="insight_expert",
        system=_NPS_SYSTEM,
        user=prompt,
        output_schema=NpsExpertOutput,
    )
    return output


# ── CSAT Expert ───────────────────────────────────────────────────────────────

_CSAT_SYSTEM = """\
You are a CSAT (Customer Satisfaction Score) measurement expert.

DOMAIN KNOWLEDGE:
- CSAT is a transactional metric: measures satisfaction with a specific interaction
- Top-box methodology: % scoring 4-5 out of 5 (not raw average) is industry standard
- Benchmarks (top-box %): Best-in-class >80% | Good 70-80% | Average 60-70% | Poor <60%
- CSAT < 3.5/5 with >20% scoring 1-2 indicates systemic failure, not one-off incidents
- CSAT and NPS divergence signals: high CSAT + low NPS = delivery OK but product/value concerns
- Leading driver categories: Speed (32%), Quality (28%), Helpfulness (22%), Ease (18%)

ANALYTICAL APPROACH:
1. Convert raw CSAT to top-box estimate for industry comparison
2. Flag systemic failure risk if score < 3.5
3. Contextualise against best-in-class benchmarks
4. Generate a plausible driver hypothesis from the score pattern

Return JSON only — no markdown, no preamble."""

async def narrate_csat_insight(
    score: float,
    n: int,
    ci_low: float,
    ci_high: float,
) -> CsatExpertOutput:
    # Rough top-box estimate: assume normal-ish distribution, score/5 → pct
    top_box_est = round(max(0.0, (score - 3.0) / 2.0 * 100), 1)
    prompt = (
        f"CSAT={score}/5, n={n}, 95% CI=[{ci_low:.2f}, {ci_high:.2f}]. "
        f"Estimated top-box (4-5/5): ~{top_box_est}%.\n"
        "Write a headline (≤160 chars) and 2-3 sentence narrative. "
        "Include benchmark_context, top_box_pct (refined estimate), and key_driver_hypothesis."
    )
    output, _ = await call_agent(
        agent_name="insight_expert",
        system=_CSAT_SYSTEM,
        user=prompt,
        output_schema=CsatExpertOutput,
    )
    return output


# ── Topic CX Expert ───────────────────────────────────────────────────────────

_TOPIC_SYSTEM = """\
You are a Customer Experience (CX) analyst specializing in Voice of Customer (VoC) thematic analysis.

DOMAIN KNOWLEDGE — CX Friction Taxonomy:
  product:  Feature gaps, usability issues, bugs, performance
  process:  Long wait times, complex workflows, multi-step tasks, escalation loops
  people:   Agent knowledge, empathy, consistency, ownership
  policy:   Rigid rules, limited exceptions, transparency issues
  price:    Perceived value gap, billing confusion, fee transparency
  none:     Positive feedback or neutral observation

ANALYTICAL FRAMEWORKS:
- Customer Effort Score (CES): High effort mentions (repeat contacts, multi-step, escalations) predict churn
- Emotional journey: frustration → anger signals acute failure; disappointment → sadness signals systemic gaps
- 5-Why depth: Ask "why" once on the cluster data to generate a root cause hypothesis
- Impact prioritisation: Volume × Sentiment Intensity × Effort score = intervention urgency

CITATION FORMAT: Reference response IDs as [rXXXXXXXX] (first 8 chars) inline in the narrative.

Return JSON only — no markdown, no preamble."""

async def narrate_topic_insight(
    aspect: str,
    size: int,
    sentiment: str,
    emotion: str,
    effort: float,
    is_new: bool,
    sample_quotes: list[str],
    citation_ids: list[str],
    overlay: str = "",
) -> TopicExpertOutput:
    cite_refs = [f"[r{rid[:8]}]" for rid in citation_ids[:3] if rid]
    new_flag = " [NEW TOPIC - first appearance this run]" if is_new else ""
    prompt = (
        f"Topic: '{aspect}'{new_flag}\n"
        f"Volume: {size} mentions | Sentiment: {sentiment} | Emotion: {emotion} | "
        f"Effort score: {effort:.1f}/7 (7=highest friction)\n"
        f"Sample quotes: {json.dumps(sample_quotes[:3])}\n"
        f"Cite these response IDs inline: {cite_refs}\n\n"
        "Write a headline (≤160 chars) and 2-3 sentence narrative using the [rXXXXXXXX] format. "
        "Classify friction_type, provide root_cause_hypothesis and business_impact."
    )
    system = _TOPIC_SYSTEM + (f"\n\nINDUSTRY CONTEXT:\n{overlay}" if overlay else "")
    output, _ = await call_agent(
        agent_name="insight_expert",
        system=system,
        user=prompt,
        output_schema=TopicExpertOutput,
    )
    return output


# ── Trend Forecaster ──────────────────────────────────────────────────────────

_TREND_SYSTEM = """\
You are a quantitative CX analyst specialising in survey response volume and engagement forecasting.

DOMAIN KNOWLEDGE:
- Response rate decay: Surveys lose ~20% response rate per additional week of distribution
- Volume spikes: >50% week-over-week often indicates an external trigger (product launch, service incident)
- Volume drops: >30% WoW drop signals survey fatigue, list decay, or delivery issues
- Seasonality baselines: B2C surveys drop 40-60% in December/August; B2B drops in July
- Early churn signal: When detractor volume rises AND response volume drops simultaneously
- Forecast reliability: ±25% accuracy for 7-day forecasts; treat as directional, not precise

CONFIDENCE CALIBRATION:
  high: slope stable for 14+ days, n > 100/week, R² > 0.8
  medium: slope stable 7-14 days or n < 100/week
  low: fewer than 7 data points, high variance, or anomaly detected

Return JSON only — no markdown, no preamble."""

async def narrate_trend_insight(
    trend: str,
    forecast_7d: int,
    delta_pct: float,
    slope: float,
    anomaly: bool,
    total_responses: int,
) -> TrendExpertOutput:
    prompt = (
        f"Response volume trend: {trend.upper()}\n"
        f"Delta vs prior period: {delta_pct:+.1f}% | Daily slope: {slope:+.2f}/day\n"
        f"7-day forecast: {forecast_7d} responses | Anomaly detected: {anomaly}\n"
        f"Total responses in window: {total_responses}\n\n"
        "Write a headline (≤160 chars) and 2-3 sentence narrative. "
        "Set confidence, causal_hypothesis, early_warning_signal (bool), and recommended_monitoring."
    )
    output, _ = await call_agent(
        agent_name="insight_expert",
        system=_TREND_SYSTEM,
        user=prompt,
        output_schema=TrendExpertOutput,
    )
    return output


# ── Prescriptive Advisor ──────────────────────────────────────────────────────

_PRESCRIPTIVE_SYSTEM = """\
You are a CX program strategist who transforms customer insights into prioritized, ROI-justified actions.

ANALYTICAL FRAMEWORKS:
ICE Score (rate each 1-10):
  Impact:     Business impact if this issue is resolved (revenue, churn, satisfaction)
  Confidence: How certain are we the action will fix the root cause
  Ease:       How easy is implementation (10=hours, 1=months of engineering)
  Priority = (Impact + Confidence + Ease) / 3 → map to critical/high/medium/low

Time horizon:
  quick_win:    < 30 days — process tweak, FAQ update, auto-response, escalation rule
  medium_term:  30-90 days — workflow redesign, training program, product fix sprint
  strategic:    > 90 days — platform rebuild, org restructure, policy change

Impact estimation heuristics:
  - Fixing top friction topic with >20% detractor correlation → NPS +5 to +15 pts typically
  - Reducing CES by 1 point → ~10% reduction in churn intent
  - Closing a top negative topic for 50+ respondents → CSAT +0.3 to +0.5 pts

TONE: Specific, action-oriented, confident. Avoid vague advice like "investigate further."

Return JSON only — no markdown, no preamble."""

async def narrate_prescriptive_insight(
    aspect: str,
    size: int,
    sentiment: str,
    friction_type: str,
    nps_score: float | None,
    csat_score: float | None,
    effort_score: float,
    overlay: str = "",
    top_drivers: list[dict] | None = None,
) -> PrescriptiveExpertOutput:
    metric_context = ""
    if nps_score is not None:
        metric_context += f" | Survey NPS={nps_score}"
    if csat_score is not None:
        metric_context += f" | CSAT={csat_score}/5"

    # Build NPS-impact driver context so the LLM grounds its action in real data
    driver_context = ""
    if top_drivers:
        lines = []
        for d in top_drivers[:5]:
            name = d.get("name", "")
            nps_impact = d.get("nps_impact")
            volume = d.get("response_count") or d.get("volume", 0)
            sent = d.get("avg_sentiment_score", 0.0)
            effort = d.get("avg_effort_score") or d.get("effort_score", 4.0)
            if nps_impact is not None:
                direction = "pain driver" if nps_impact < 0 else "strength driver"
                lines.append(
                    f"  - {name}: NPS impact={nps_impact:+.1f} ({direction}), "
                    f"vol={volume}, sentiment={sent:.2f}, effort={effort:.1f}/7"
                )
        if lines:
            driver_context = "\n\nNPS driver analysis (most impactful topics):\n" + "\n".join(lines)
            driver_context += (
                "\n\nFocus your action on the highest-magnitude pain driver above. "
                "If fixing the top pain driver could address multiple negative topics, say so."
            )

    prompt = (
        f"Top friction point: '{aspect}'\n"
        f"Volume: {size} mentions | Sentiment: {sentiment} | Friction type: {friction_type}\n"
        f"Effort score: {effort_score:.1f}/7{metric_context}{driver_context}\n\n"
        "Generate a specific, actionable prescriptive insight. "
        "Set headline, narrative, priority, time_horizon, estimated_impact, "
        "ice_impact, ice_confidence, ice_ease (each 1-10)."
    )
    system = _PRESCRIPTIVE_SYSTEM + (f"\n\nINDUSTRY CONTEXT:\n{overlay}" if overlay else "")
    output, _ = await call_agent(
        agent_name="insight_expert",
        system=system,
        user=prompt,
        output_schema=PrescriptiveExpertOutput,
    )
    return output


# ── Insight Set Evaluator ─────────────────────────────────────────────────────

_EVALUATE_SYSTEM = """\
You are a senior CX insights quality analyst. Evaluate a complete set of AI-generated insights.

EVALUATION CRITERIA:
1. Coverage (0-100): Do the insights represent all major themes in the underlying data?
   - Check: Are there topics from the topics list NOT addressed by any insight?
2. Balance (0-100): Are both positive and negative insights represented?
   - Red flag: 100% negative insights even when metrics are above benchmark
3. Actionability (0-100): Do prescriptive insights have specific, time-bound next steps?
   - Penalize vague advice like "investigate further" or "monitor the situation"
4. Redundancy: Flag insights that say essentially the same thing (same claim, same data)
5. Overall quality: Weighted average (coverage 30%, balance 25%, actionability 25%, non-redundancy 20%)

OUTPUT: Return a single JSON object with these exact fields:
- overall_quality, coverage_score, balance_score, actionability_score: integers 0-100
- redundant_indices: array of integers (0-based indices to drop), or []
- missing_themes: array of strings, or []
- improvements: array of objects {index: int, issue: string, suggestion: string}, or []
- narrative_coherence: string

Return JSON only — no markdown, no preamble."""

async def evaluate_insight_set(
    insights: list[dict],
    topics: list[dict],
    metrics: dict,
    total_responses: int,
) -> InsightSetEvaluatorOutput:
    insight_summaries = [
        {
            "index": i,
            "layer": ins.get("layer"),
            "category": ins.get("category"),
            "headline": ins.get("headline"),
            "trust_score": ins.get("trust_score"),
            "priority": ins.get("priority"),
        }
        for i, ins in enumerate(insights)
    ]
    topic_names = [t.get("name", "") for t in topics if isinstance(t, dict)]
    metric_summary = {
        k: v.get("score") if isinstance(v, dict) else v
        for k, v in metrics.items()
        if k in ("nps", "csat", "total_responses")
    }

    prompt = (
        f"Total responses: {total_responses}\n"
        f"Metrics: {json.dumps(metric_summary)}\n"
        f"Topic names from data: {topic_names}\n\n"
        f"Insights ({len(insights)} total):\n{json.dumps(insight_summaries, indent=2)}\n\n"
        "Evaluate coverage, balance, actionability, redundancy. "
        "Return InsightSetEvaluatorOutput with scores, redundant_indices (0-based), "
        "missing_themes, and per-insight improvements."
    )
    output, _ = await call_agent(
        agent_name="insight_evaluate",
        system=_EVALUATE_SYSTEM,
        user=prompt,
        output_schema=InsightSetEvaluatorOutput,
    )
    return output


# ── Crystal Evaluator ─────────────────────────────────────────────────────────

_CRYSTAL_EVAL_SYSTEM = """\
You are a QA reviewer for an AI-powered CX analyst (Crystal). Evaluate the assistant's response.

EVALUATION CRITERIA:
1. answers_question: Does the response directly address what the user asked? (not a tangential answer)
2. is_grounded: Are all factual claims backed by the insight/topic/metrics context provided?
3. hallucinated_ids: List any cited insight IDs [abc123] that are NOT in the provided context
4. quality_score (0-100):
   - 90-100: Direct, precise, fully grounded, no filler, insightful follow-ups
   - 70-89:  Good but minor issues (slight vagueness, one uncited claim)
   - 50-69:  Partially answers question or has grounding issues
   - 0-49:   Fails to answer, hallucinates data, or is generic/unhelpful
5. issues: List specific problems found
6. correction: One clear instruction to fix on retry (empty string if no retry needed)

Return JSON only — no markdown, no preamble."""

async def evaluate_crystal_response(
    user_question: str,
    answer: str,
    valid_insight_ids: set[str],
    cited_ids: list[str],
    metrics_context: str,
) -> CrystalEvalOutput:
    hallucinated = [cid for cid in cited_ids if cid and cid not in valid_insight_ids]
    prompt = (
        f"User question: {user_question}\n\n"
        f"Crystal's answer: {answer}\n\n"
        f"Valid insight IDs in context: {sorted(valid_insight_ids)[:20]}\n"
        f"IDs Crystal cited: {cited_ids}\n"
        f"Pre-detected hallucinated IDs (not in context): {hallucinated}\n"
        f"Available metrics: {metrics_context}\n\n"
        "Evaluate and return CrystalEvalOutput."
    )
    output, _ = await call_agent(
        agent_name="crystal_eval",
        system=_CRYSTAL_EVAL_SYSTEM,
        user=prompt,
        output_schema=CrystalEvalOutput,
    )
    # Always trust the deterministic hallucination check over the LLM's list
    if hallucinated:
        output.hallucinated_ids = list(set(output.hallucinated_ids + hallucinated))
        output.is_grounded = False
    return output


# ── Survey Bias Detector ──────────────────────────────────────────────────────

_BIAS_SYSTEM = """\
You are a survey methodology expert specializing in question bias detection.

BIAS TYPES TO DETECT:
1. leading: Question presupposes a positive/negative answer
   e.g. "How great was your experience?" → biased; "How would you rate your experience?" → neutral
2. double_barreled: Asks two things in one question
   e.g. "Was our product fast and easy to use?" → biased (two separate questions)
3. loaded: Contains emotionally charged or assumption-laden language
   e.g. "Why do you love our product?" → assumes love
4. absolute: Uses extreme words that inflate positive responses
   e.g. "Do you always prefer us?" → 'always' is absolute
5. social_desirability: Makes one answer feel socially correct
   e.g. "Do you agree that sustainability is important?" → most say yes
6. acquiescence: Question structure makes agreement the path of least resistance
   e.g. 5 "agree/disagree" questions in a row → respondents tend to agree to all

Rate overall_bias_score: 100=no bias found, lower with each issue found (-10 per issue max 5 issues).

Return JSON only — no markdown, no preamble."""

async def check_survey_bias(questions: list[dict]) -> SurveyBiasOutput:
    summaries = [
        {"id": q.get("id"), "type": q.get("type"), "question": q.get("question", "")[:200]}
        for q in questions
    ]
    prompt = (
        f"Survey questions:\n{json.dumps(summaries, indent=2)}\n\n"
        "Detect bias issues. For each biased question, return: "
        "{question_id, issue_type (leading|double_barreled|loaded|absolute|social_desirability|acquiescence), "
        "description, suggestion}. Set overall_bias_score (100=no bias)."
    )
    output, _ = await call_agent(
        agent_name="survey_bias",
        system=_BIAS_SYSTEM,
        user=prompt,
        output_schema=SurveyBiasOutput,
    )
    return output


# ── Survey Quality Evaluator ──────────────────────────────────────────────────

_SURVEY_EVAL_SYSTEM = """\
You are a survey design quality reviewer with expertise in CX measurement.

EVALUATION DIMENSIONS:
1. quality_score (0-100): Overall survey quality
2. balance_score (0-100): Mix of closed/open questions, metric/qualitative balance
   - Good: 60-70% closed, 30-40% open, at least 1 metric question (NPS/CSAT/rating)
3. coverage_score (0-100): Does the survey cover the stated intent?
   - Check: Does every stated goal have at least one measuring question?
4. flow_score (0-100): Logical question order + skip/display logic quality
   - Good flow: General → Specific, Behavioral → Attitudinal, Closed → Open
   - Skip logic: All destinations are later questions; no infinite loops
5. strengths: List 2-3 specific strengths
6. weaknesses: List 2-3 specific issues to address on next revision
7. recommendation: One concrete improvement to make the most impact

Return JSON only — no markdown, no preamble."""

async def evaluate_survey(
    questions: list[dict],
    intent: str,
    survey_type: str,
) -> SurveyEvalOutput:
    summaries = [
        {
            "id": q.get("id"),
            "type": q.get("type"),
            "question": q.get("question", "")[:150],
            "required": q.get("required"),
            "has_skip_logic": bool(q.get("skipLogic")),
            "has_display_logic": bool(q.get("displayLogic")),
        }
        for q in questions
    ]
    prompt = (
        f"Survey intent: {intent}\n"
        f"Survey type: {survey_type}\n"
        f"Questions ({len(questions)} total):\n{json.dumps(summaries, indent=2)}\n\n"
        "Evaluate and return SurveyEvalOutput with quality_score, balance_score, "
        "coverage_score, flow_score, strengths, weaknesses, recommendation."
    )
    output, _ = await call_agent(
        agent_name="survey_evaluate",
        system=_SURVEY_EVAL_SYSTEM,
        user=prompt,
        output_schema=SurveyEvalOutput,
    )
    return output
