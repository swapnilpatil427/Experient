"""Crystal — Stateful Conversational AI Analyst for the Insights Page.

Crystal is the expert CX analyst embedded in the SurveyInsightsPage. Unlike the
stateless NLQ endpoint (POST /ask), Crystal maintains a conversation thread so
follow-up questions build on earlier context.

Production features:
  - Hallucination filter: deterministically validates all cited IDs against context
  - LLM Evaluator: scores answer quality (grounding, relevance, completeness)
  - Self-correction loop: up to 2 retries when eval score < 72 or grounding fails
  - Type-safe context builders: coerce all numeric fields from DB (can arrive as str)

Design:
  - Single LLM call per user message (retried only on quality failure)
  - Full context: insights list, topics, metrics, survey metadata
  - Conversation history passed in and managed by backend (crystal_threads table)
  - Returns structured output: answer + citations + follow-up suggestions + insight refs
  - Does NOT modify surveys — refer users to Copilot for that

Used by: POST /api/insights/:surveyId/crystal (backend/src/routes/local/insights.js)
Called via: POST /insights/crystal (agents/main.py)
"""
from __future__ import annotations

import json
import re
import uuid
from typing import Literal

from pydantic import BaseModel, field_validator


def _format_tool_result(tool_name: str, result: dict, char_limit: int = 2000) -> str:
    """Format a tool result as a concise structured summary for LLM context.

    Replaces the raw JSON[:500] truncation with tool-aware summaries that
    preserve the most important signals within a larger character budget.
    Enterprise surveys with 30+ topics can saturate 500 chars in a single topic.
    """
    if not isinstance(result, dict):
        return str(result)[:char_limit]

    if result.get("error"):
        return f"[error: {result['error']}]"

    # Topics tool — most important for enterprise
    if tool_name in ("get_topics", "list_topics"):
        topics = result.get("topics", [])
        lines = [f"Topics ({len(topics)} total):"]
        for t in topics[:12]:
            name    = t.get("name", "?")
            vol     = t.get("volume") or t.get("response_count", 0)
            sent    = t.get("sentiment_score", 0.0)
            impact  = t.get("nps_impact")
            urgency = t.get("urgency_score", 0.0)
            trend   = t.get("trending", "")
            impact_str = f", NPS_impact={impact:+.1f}" if impact is not None else ""
            trend_str  = f" [{trend}]" if trend in ("up", "down") else ""
            lines.append(f"  {name}{trend_str}: vol={vol}, sentiment={sent:.2f}{impact_str}, urgency={urgency:.1f}")
        return "\n".join(lines)[:char_limit]

    # Insights tool
    if tool_name in ("get_insights", "list_insights"):
        insights = result.get("insights", [])
        lines = [f"Insights ({len(insights)} total):"]
        for ins in insights[:10]:
            cat  = ins.get("category", "")
            head = ins.get("headline", "")[:80]
            trust = ins.get("trust_score", 0)
            lines.append(f"  [{cat}] {head} (trust={trust})")
        return "\n".join(lines)[:char_limit]

    # Metrics / NPS tool
    if "nps" in tool_name or "metrics" in tool_name or "score" in tool_name:
        lines = []
        for k, v in result.items():
            if isinstance(v, dict):
                score = v.get("score")
                n     = v.get("n")
                if score is not None:
                    lines.append(f"  {k}: {score}" + (f" (n={n})" if n else ""))
            elif v is not None and not isinstance(v, (list, dict)):
                lines.append(f"  {k}: {v}")
        return ("Metrics:\n" + "\n".join(lines)) if lines else json_dumps_safe(result)[:char_limit]

    # Verbatims / quotes tool
    if "verbatim" in tool_name or "quote" in tool_name or "response" in tool_name:
        verbatims = result.get("verbatims") or result.get("quotes") or result.get("responses", [])
        if verbatims:
            lines = [f"Verbatims ({len(verbatims)} total):"]
            for v in verbatims[:8]:
                text = (v.get("text") or str(v))[:120]
                sent = v.get("sentiment", "")
                lines.append(f'  [{sent}] "{text}"')
            return "\n".join(lines)[:char_limit]

    # Default: flatten to key: value pairs, skipping large nested objects
    lines = []
    for k, v in result.items():
        if isinstance(v, list):
            lines.append(f"{k}: [{len(v)} items]")
        elif isinstance(v, dict):
            lines.append(f"{k}: {json_dumps_safe(v)[:100]}")
        elif v is not None:
            lines.append(f"{k}: {v}")
    return "\n".join(lines)[:char_limit]

from crystalos.lib.openrouter import call_agent
from crystalos.lib.logger import logger
from crystalos.lib.constants import CRYSTAL_EVAL_PASS_THRESHOLD
from crystalos.agents.insight_experts import evaluate_crystal_response


class CrystalInput(BaseModel):
    survey_id: str
    org_id: str
    message: str
    insights: list[dict]                   # current insights list (up to 30)
    topics: list[dict] = []                # survey topics with sentiment/volume
    survey_title: str = ""
    survey_response_count: int = 0
    metrics: dict = {}                     # {nps: {score, n}, csat: {score, n}}
    conversation_history: list[dict] = []  # [{role, content}], last 10 messages
    user_id: str = ""
    scope: str = "survey"
    has_open_text: bool = True
    tag_ids: list[str] | None = None       # group scope: tag UUIDs
    tag_id: str | None = None              # tag scope: single tag UUID (backend sends this, singular)
    user_role: str = "viewer"              # viewer | editor | admin | brand_admin
    brand_id: str | None = None            # enterprise brand override (None = first-party)

    # ── Wave 15 — Automation Hub workflow-builder context (additive/optional) ──
    # Every field below defaults to today's exact behavior when absent, so every
    # existing caller (Insights pages, org portfolio, group insights, etc.) is
    # byte-identical. See docs/automation-hub/TRACKER.md Wave 15.
    #
    # `surface` (rather than inferring "we're in the builder" from
    # `builder_draft is not None`) is the explicit signal: a user can open the
    # workflow builder's Crystal icon and ask a first question before any
    # trigger/action has been configured yet, i.e. `builder_draft=None` while
    # still very much "in the builder." Inferring from `builder_draft` would
    # misroute that first-turn case back to `crystal-analyst`. An explicit
    # field also makes the routing decision (see `_run_skill_stream`) a simple,
    # auditable `if inp.surface == "workflow_builder"` rather than an implicit
    # heuristic on an unrelated payload field.
    surface: str = "insights"              # "insights" (default, unchanged) | "workflow_builder"
    # Current workflow draft summary, mirroring the frontend's
    # `BuilderDraftSummary` (app/src/contexts/crystalPanel.tsx): mode,
    # triggerType, scopeSelection, conditionClauses, actions, workflowName,
    # isEditMode. Forwarded into skill context verbatim — never parsed here.
    builder_draft: dict | None = None
    # Trigger/conditionFields/conditionOperators/actions catalog — same shape
    # `parse_workflow_nl` already receives as its `registry` parameter
    # (backend/src/lib/workflowRegistry.ts is the source of truth; the Node
    # proxy attaches it to the request body when builder context is active).
    workflow_registry: dict | None = None


class ActionProposal(BaseModel):
    """A proposed action Crystal returns for user confirmation.

    The frontend renders this as an action card. When the user confirms,
    the frontend calls the appropriate backend API using params.
    Crystal never executes write operations autonomously.
    """
    id:                   str                    # unique kebab-case ID, e.g. "create-detractor-survey"
    type:                 str                    # create_survey | edit_survey | distribute | workflow | create_alert | template | schedule_rerun
    title:                str                    # imperative label, max 60 chars
    description:          str                    # what + why, 1-2 sentences
    cta_label:            str = "Apply"          # button label shown in UI
    params:               dict = {}              # execution params passed to frontend API
    priority:             str = "medium"         # critical | high | medium | low
    estimated_time:       str = ""               # "5 min", "2 hours", etc.
    business_rationale:   str = ""               # expected business impact
    requires_confirmation: bool = True           # always True — safety guarantee


from crystalos.lib.json_coerce import extract_skill_answer, json_dumps_safe, normalize_suggestions


class VizSpec(BaseModel):
    """Neutral, versioned generative-UI payload (MIGRATION_PLAN.md §3 mitigation #5).

    Deliberately NOT assistant-ui's own spec shape — the frontend adapter
    translates. ``kind`` is a closed server allowlist (one member for this G0
    spike); adding a widget type means adding a Literal member here AND a
    matching entry in the frontend's total render map, never a free string.
    """
    viz_version: Literal[1] = 1
    kind: Literal["nps_bar_chart", "sentiment_by_segment_chart"]
    title: str
    data: list[dict]                     # nps_bar_chart: [{"segment": str, "score": float}, ...]
                                          # sentiment_by_segment_chart: [{"segment": str, "sentiment_score": float}, ...]
    source_insight_id: str | None = None


class AppliedFilter(BaseModel):
    """One resolved 'what Crystal actually scoped/searched' fact for this
    turn, surfaced to the frontend as a transparency/trust affordance.
    Deliberately ONE flat shape — every tool argument family in
    crystal/registry.py's TOOL_REGISTRY normalizes into it; a new tool
    reusing any existing argument name is normalized automatically."""
    kind: str
    label: str
    value: str
    raw: dict = {}
    sources: list[str] = []


class CrystalOutput(BaseModel):
    answer: str                          # 2-5 sentences, concise and evidence-based
    citations: list[str] = []            # insight IDs or topic names referenced
    suggestions: list[str] = []          # 2-3 follow-up questions
    insight_refs: list[str] = []         # insight IDs used in the answer
    action_proposals: list[ActionProposal] = []  # proposed actions (from action tools)
    viz: VizSpec | None = None           # Tier-0 deterministic chart — never model-chosen
    applied_filters: list[AppliedFilter] = []  # transparency: what Crystal scoped/searched this turn
    # Server-minted, set by the caller (not by any synthesis path) after this
    # object is built — see _run_skill_stream/_run_react_loop_streaming/_run_skill_loop.
    # Same value as the crystal_turn_events row this turn writes (G1 fix).
    turn_id: str | None = None

    @field_validator("suggestions", mode="before")
    @classmethod
    def _normalize_suggestions(cls, v):
        return normalize_suggestions(v)


# ── ReAct step protocol ───────────────────────────────────────────────────────
# OpenRouter has no native function-calling (JSON mode only), so the ReAct loop
# uses a JSON tool-call protocol: each LLM turn returns either tool calls to run
# or a signal that it has enough data to answer.

class ReActToolCall(BaseModel):
    tool: str
    args: dict = {}


class ReActStep(BaseModel):
    thought: str = ""                    # brief reasoning about what to do next
    action: str = "final"                # "tool_call" | "final"
    tool_calls: list[ReActToolCall] = [] # tools to run this turn (when action == tool_call)
    answer: str = ""                     # draft answer (when action == final; re-synthesized + evaluated downstream)
    citations: list[str] = []
    suggestions: list[str] = []
    insight_refs: list[str] = []

    @field_validator("suggestions", mode="before")
    @classmethod
    def _normalize_suggestions(cls, v):
        return normalize_suggestions(v)


# ── Thread management ─────────────────────────────────────────────────────────

async def get_or_create_thread(ctx, db_pool) -> dict:
    """UPSERT into crystal_threads. Resets thread if inactive > 7 days."""
    from crystalos.lib.constants import CRYSTAL_THREAD_INACTIVITY_TTL_DAYS
    from crystalos.lib import db as _db

    try:
        async with _db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                # Check for existing thread
                await cur.execute(
                    """SELECT id, messages, last_active_at, message_count
                       FROM crystal_threads
                       WHERE org_id = %s AND user_id = %s
                         AND (survey_id = %s OR (survey_id IS NULL AND %s IS NULL))
                         AND scope = %s
                       LIMIT 1""",
                    (ctx.org_id, ctx.user_id, ctx.survey_id, ctx.survey_id, ctx.scope),
                )
                row = await cur.fetchone()

                if row:
                    thread_id, messages, last_active_at, message_count = row
                    # Check TTL
                    from datetime import datetime, timezone
                    now = datetime.now(timezone.utc)
                    if last_active_at and hasattr(last_active_at, 'tzinfo'):
                        stale_days = (now - last_active_at).days
                    else:
                        stale_days = 0

                    if stale_days >= CRYSTAL_THREAD_INACTIVITY_TTL_DAYS:
                        # Reset thread - start fresh
                        await conn.execute(
                            """UPDATE crystal_threads
                               SET messages = '[]'::jsonb, message_count = 0,
                                   last_active_at = NOW()
                               WHERE id = %s""",
                            (thread_id,),
                        )
                        await conn.commit()
                        logger.info("crystal_thread_reset_stale", thread_id=str(thread_id), stale_days=stale_days)
                        return {"id": str(thread_id), "messages": [], "is_new": True}

                    # Continue existing thread
                    msgs = messages if isinstance(messages, list) else []
                    return {"id": str(thread_id), "messages": msgs, "is_new": False}

                # Create new thread
                await cur.execute(
                    """INSERT INTO crystal_threads
                       (org_id, user_id, survey_id, scope, messages, message_count,
                        last_active_at, storage_expires_at)
                       VALUES (%s, %s, %s, %s, '[]'::jsonb, 0, NOW(), NOW() + INTERVAL '90 days')
                       RETURNING id""",
                    (ctx.org_id, ctx.user_id, ctx.survey_id, ctx.scope),
                )
                new_row = await cur.fetchone()
                await conn.commit()
                return {"id": str(new_row[0]), "messages": [], "is_new": True}
    except Exception as exc:
        logger.warning("crystal_thread_get_or_create_failed", error=str(exc))
        return {"id": None, "messages": [], "is_new": True}


async def append_to_thread(thread_id: str, role: str, content: str) -> None:
    """Append a message to crystal_threads.messages JSONB array."""
    if not thread_id:
        return
    import json as _json
    from datetime import datetime, timezone
    from crystalos.lib import db as _db

    msg = _json.dumps({"role": role, "content": content, "ts": datetime.now(timezone.utc).isoformat()})
    try:
        async with _db._pool_conn().connection() as conn:
            await conn.execute(
                """UPDATE crystal_threads
                   SET messages = CASE
                           WHEN jsonb_array_length(messages) >= 100
                           THEN (messages - 0) || %s::jsonb
                           ELSE messages || %s::jsonb
                       END,
                       last_active_at = NOW(),
                       message_count = message_count + 1
                   WHERE id = %s""",
                (f"[{msg}]", f"[{msg}]", thread_id),
            )
    except Exception as exc:
        logger.warning("crystal_thread_append_failed", thread_id=thread_id, error=str(exc))


# ── Insight layer order for structured context ────────────────────────────────

_LAYER_ORDER = ["descriptive", "diagnostic", "predictive", "prescriptive"]
_LAYER_LABELS = {
    "descriptive":  "WHAT (Descriptive)",
    "diagnostic":   "WHY (Diagnostic)",
    "predictive":   "WHAT NEXT (Predictive)",
    "prescriptive": "ACTIONS (Prescriptive)",
}


def _build_insights_context(insights: list[dict]) -> tuple[str, set[str]]:
    """Group insights by layer, format as structured context, return valid IDs.

    When insights include _survey_title (org scope), each entry is prefixed with
    the survey name so Crystal can cite which survey an insight comes from.
    """
    by_layer: dict[str, list[dict]] = {layer: [] for layer in _LAYER_ORDER}
    other: list[dict] = []
    valid_ids: set[str] = set()

    for ins in insights:
        layer = ins.get("layer", "")
        ins_id = str(ins.get("id", ""))
        if ins_id:
            valid_ids.add(ins_id)
        if layer in by_layer:
            by_layer[layer].append(ins)
        else:
            other.append(ins)

    lines: list[str] = []
    for layer in _LAYER_ORDER:
        layer_insights = by_layer[layer]
        if not layer_insights:
            continue
        lines.append(f"\n## {_LAYER_LABELS[layer]}")
        for ins in layer_insights:
            ins_id  = ins.get("id", "")
            headline = ins.get("headline", "")
            narrative = ins.get("narrative", "")
            trust    = ins.get("trust_score")
            metric   = ins.get("metric_json")
            # Survey attribution — present when scope is org (cross-survey insights)
            survey_title = ins.get("_survey_title", "")
            survey_id    = ins.get("survey_id", "") or ins.get("_survey_id", "")

            survey_tag = f" [Survey: {survey_title}]" if survey_title else ""
            line = f"- [{ins_id}]{survey_tag} {headline}"
            if narrative:
                line += f"\n  {narrative[:200]}"
            if metric is not None:
                line += f"\n  Metric: {json_dumps_safe(metric)}"
            if trust is not None:
                try:
                    line += f"  (trust: {float(trust):.0f})"
                except (TypeError, ValueError):
                    pass
            lines.append(line)

    if other:
        lines.append("\n## OTHER")
        for ins in other:
            survey_title = ins.get("_survey_title", "")
            survey_tag = f" [Survey: {survey_title}]" if survey_title else ""
            lines.append(f"- [{ins.get('id', '')}]{survey_tag} {ins.get('headline', '')}")

    return "\n".join(lines) if lines else "No insights available yet.", valid_ids


def _build_topics_context(topics: list[dict]) -> str:
    """Format topics as a compact table-like block. Coerces all numeric fields."""
    if not topics:
        return "No topics available."

    lines = ["Topic | Volume | Sentiment | Effort | Trending"]
    lines.append("------|--------|-----------|--------|--------")
    for t in topics[:20]:
        name = t.get("name", "")
        try:
            vol = int(t.get("volume", 0) or 0)
        except (TypeError, ValueError):
            vol = 0
        try:
            sentiment = round(float(t.get("sentiment_score", 0.0) or 0.0), 2)
        except (TypeError, ValueError):
            sentiment = 0.0
        emotion = t.get("dominant_emotion", "")
        try:
            effort_raw = t.get("effort_score")
            effort_str = f"{float(effort_raw):.2f}" if effort_raw is not None else "n/a"
        except (TypeError, ValueError):
            effort_str = "n/a"
        trending = "yes" if t.get("trending") else "no"
        lines.append(f"{name} | {vol} | {sentiment} ({emotion}) | {effort_str} | {trending}")

    return "\n".join(lines)


def _build_metrics_context(metrics: dict, response_count: int) -> str:
    """Format key metrics block."""
    parts: list[str] = []
    if response_count:
        parts.append(f"Total responses: {response_count}")

    nps = metrics.get("nps")
    if nps:
        score = nps.get("score") or nps.get("value")
        n = nps.get("n") or nps.get("sample_size")
        if score is not None:
            parts.append(f"NPS score: {score}" + (f" (n={n})" if n else ""))

    csat = metrics.get("csat")
    if csat:
        score = csat.get("score") or csat.get("value")
        n = csat.get("n") or csat.get("sample_size")
        if score is not None:
            parts.append(f"CSAT score: {score}" + (f" (n={n})" if n else ""))

    return "\n".join(parts) if parts else "No key metrics available."


def _build_system_prompt(inp: CrystalInput, correction: str = "") -> str:
    title = inp.survey_title or f"Survey {inp.survey_id}"
    insights_ctx, _ = _build_insights_context(inp.insights)
    topics_ctx = _build_topics_context(inp.topics)
    metrics_ctx = _build_metrics_context(inp.metrics, inp.survey_response_count)

    correction_block = ""
    if correction:
        correction_block = f"""
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CORRECTION REQUIRED (previous attempt had issues)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{correction}

"""

    # Build scope-aware sections
    scope = inp.scope if hasattr(inp, "scope") else "survey"
    is_org = scope == "org"

    scope_header = ""
    if is_org:
        scope_header = f"""
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PORTFOLIO SCOPE — {inp.survey_response_count:,} responses across active surveys
You are analysing the full portfolio, not a single survey.
Each insight below is tagged [Survey: <name>] so you know its source.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

    nav_section = NAVIGATION_GUIDE

    return f"""\
You are Crystal, an expert CX (customer experience) analyst.
{"Your role is to synthesise intelligence across the organisation's surveys and help identify portfolio-level patterns." if is_org else f'Your role is to help the survey owner of "{title}" understand what their data means and what to do about it.'}
{correction_block}{scope_header}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KEY METRICS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{metrics_ctx}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSIGHTS (grouped by analysis layer)
Each insight is prefixed with its ID in brackets, e.g. [abc123].
{"Insights from different surveys are tagged [Survey: <name>]." if is_org else ""}
ONLY cite IDs listed here — never invent IDs.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{insights_ctx}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TOPICS (respondent themes, ordered by volume)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{topics_ctx}
{nav_section}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW TO RESPOND
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Write like a sharp colleague who knows this data cold — not like a chatbot.
Specific numbers, named themes, real quotes. Skip the preamble.

1. Lead with the finding, not the setup. "Onboarding friction is your top driver of churn [id]."
2. Ground claims in insight data. Cite IDs inline: "[abc123]". {"Name the source survey too." if is_org else "Reference topics by name."}
3. One concrete number per sentence wherever the data supports it.
4. If data doesn't support the question, say so directly: "The data here doesn't show that yet."
5. End with 2-3 follow-up questions that would actually help — vary between diagnosis, action, and navigation.
6. NEVER cite an ID not listed above. NEVER invent data. To change survey questions → direct them to the survey builder (Copilot).

Return ONLY valid JSON — no markdown, no extra text.
IMPORTANT: cite using the FULL insight ID exactly as shown above (e.g. [ba58f64c-1234-5678-abcd-ef0123456789]).
Never shorten or truncate IDs — the frontend needs the exact UUID to look up the source.
{{
  "answer": "2-5 sentence answer. Cite full IDs inline: [ba58f64c-1234-5678-abcd-ef0123456789].",
  "citations": ["ba58f64c-1234-5678-abcd-ef0123456789"],
  "suggestions": ["Follow-up question?", "Navigation suggestion like: Explore [Survey Name] Intelligence"],
  "insight_refs": ["ba58f64c-1234-5678-abcd-ef0123456789"]
}}
"""


async def _generate_response(
    inp: CrystalInput,
    correction: str = "",
    current_tokens: int = 0,
) -> tuple[CrystalOutput, int]:
    """Single LLM call to generate Crystal's response. Returns (output, tokens_used)."""
    from crystalos.lib.constants import CRYSTAL_CONVERSATION_WINDOW
    system = _build_system_prompt(inp, correction=correction)

    prior_messages: list[dict] | None = None
    if inp.conversation_history:
        prior_messages = [
            {"role": str(m["role"])[:20], "content": str(m["content"])[:2000]}
            for m in inp.conversation_history[-CRYSTAL_CONVERSATION_WINDOW * 2:]
            if m.get("role") in ("user", "assistant") and m.get("content")
        ]

    output, entry = await call_agent(
        agent_name="crystal",
        system=system,
        user=inp.message,
        output_schema=CrystalOutput,
        current_tokens=current_tokens,
        prior_messages=prior_messages,
    )
    return output, entry.input_tokens + entry.output_tokens


async def _run_crystal(inp: CrystalInput) -> CrystalOutput:
    """Generate Crystal's response with evaluator + hallucination filter + self-correction."""
    from crystalos.lib.tracer import get_tracer as _get_tracer
    from crystalos.lib.pii_scrubber import scrub as _scrub

    _, valid_ids = _build_insights_context(inp.insights)
    metrics_ctx = _build_metrics_context(inp.metrics, inp.survey_response_count)

    best_output: CrystalOutput | None = None
    best_score = -1
    correction = ""
    cumulative_tokens = 0

    for attempt in range(3):
        try:
            output, tokens_used = await _generate_response(inp, correction=correction, current_tokens=cumulative_tokens)
            cumulative_tokens += tokens_used
        except Exception as exc:
            logger.warning("crystal_generate_failed", attempt=attempt,
                           error_type=type(exc).__name__, error=str(exc))
            if best_output is not None:
                return best_output
            raise

        # ── Deterministic hallucination filter ────────────────────────────────
        cited_ids = list(set((output.citations or []) + (output.insight_refs or [])))
        hallucinated = [cid for cid in cited_ids if cid and cid not in valid_ids]
        if hallucinated:
            # Strip hallucinated IDs from both fields before evaluating
            output.citations  = [c for c in output.citations  if c not in hallucinated]
            output.insight_refs = [r for r in output.insight_refs if r not in hallucinated]
            logger.warning(
                "crystal_hallucinated_ids_stripped",
                attempt=attempt,
                hallucinated=hallucinated,
            )

        # ── LLM quality evaluation ────────────────────────────────────────────
        try:
            eval_result = await evaluate_crystal_response(
                user_question=inp.message,
                answer=output.answer,
                valid_insight_ids=valid_ids,
                cited_ids=cited_ids,
                metrics_context=metrics_ctx,
            )
        except Exception as exc:
            logger.warning("crystal_eval_failed", attempt=attempt, error=str(exc))
            # Evaluation failed — accept output as-is on the first attempt
            if best_output is None:
                best_output = output
            break

        score = eval_result.quality_score
        if score > best_score:
            best_score = score
            best_output = output

        passes = (
            eval_result.quality_score >= CRYSTAL_EVAL_PASS_THRESHOLD
            and eval_result.is_grounded
            and eval_result.answers_question
        )

        logger.info(
            "crystal_eval",
            attempt=attempt,
            score=score,
            grounded=eval_result.is_grounded,
            answers_question=eval_result.answers_question,
            issues=eval_result.issues,
            passes=passes,
        )

        if passes:
            break

        if attempt < 2:
            # Build a concrete correction instruction for the next attempt
            issue_list = "; ".join(eval_result.issues[:3]) if eval_result.issues else "quality below threshold"
            hallucination_note = (
                f" Do NOT cite these IDs (they don't exist in context): {eval_result.hallucinated_ids}."
                if eval_result.hallucinated_ids else ""
            )
            correction = (
                f"Previous answer had issues: {issue_list}.{hallucination_note} "
                f"{eval_result.correction or 'Improve directness and grounding.'}"
            )

    assert best_output is not None  # at least one attempt always sets this

    logger.info(
        "crystal_response",
        survey_id=inp.survey_id,
        org_id=inp.org_id,
        insight_count=len(inp.insights),
        suggestion_count=len(best_output.suggestions),
        final_score=best_score,
    )
    # Langfuse — log Crystal Q&A as a generation so it appears in traces
    try:
        _get_tracer().log_generation(
            name="crystal_qa",
            model="crystal",
            input={"question": _scrub(inp.message)[:500], "survey_id": inp.survey_id},
            output={
                "answer":      best_output.answer[:500],
                "eval_score":  best_score,
                "suggestions": best_output.suggestions,
                "citations":   best_output.citations,
            },
            usage={"input": 0, "output": cumulative_tokens, "unit": "TOKENS"},
        )
    except Exception:
        pass
    return best_output


# ── Permission map — tools requiring elevated access ──────────────────────────

TOOL_PERMISSION_MAP: dict[str, str] = {
    "export_responses":    "data:export",
    "view_respondent_pii": "data:pii",
    "configure_alerts":    "workflow:write",
    "manage_survey":       "survey:write",
}

# ── Navigation guide — route-based, not vague strings ────────────────────────

NAVIGATION_GUIDE = """
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
APP NAVIGATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When recommending navigation:
- Put plain-text follow-up prompts in "suggestions" only (e.g. "Open the response dashboard").
- NEVER put JSON objects in "suggestions" — that field must be an array of strings.
- In your "answer", reference destinations in prose (e.g. "Open the Responses tab" or name the survey).

Available routes (for your reference when writing answer text):
- /app/surveys — survey list
- /app/surveys/{survey_id}/build — survey builder
- /app/surveys/{survey_id}/responses — response dashboard
- /app/insights — cross-survey insights hub
- /app/insights/advanced — advanced analytics
- /app/workflows — automation workflows
- /app/settings — account settings
- /app/respondents — respondent directory

Rules:
- Always use the actual route pattern when naming paths, substituting real survey IDs you know from context
- Multiple navigation follow-ups in one turn are fine — each as a separate string in "suggestions"
"""


def _build_brand_identity(ctx) -> str:
    """Return Crystal's self-introduction based on the brand context."""
    brand = getattr(ctx, "brand", None)
    if brand and brand.brand_persona:
        return brand.brand_persona
    elif brand:
        return f"Crystal, the AI intelligence layer for {brand.brand_name} — powered by Xperiq"
    return "Crystal — the Xperiq Intelligence Platform"


def _build_custom_instructions(ctx) -> str:
    """Return brand custom_instructions block if set."""
    brand = getattr(ctx, "brand", None)
    if brand and brand.custom_instructions:
        return f"\n\n## Brand Guidance\n{brand.custom_instructions}"
    return ""


def _build_filtered_tool_list(ctx, tools: list[dict]) -> list[dict]:
    """Return only tools the user's effective permissions allow.

    Tools with no entry in TOOL_PERMISSION_MAP are always included.
    Brand restricted_features are excluded regardless of permissions.
    """
    effective_perms = getattr(ctx, "effective_perms", frozenset())
    brand = getattr(ctx, "brand", None)
    restricted = brand.restricted_features if brand else frozenset()

    filtered = []
    for t in tools:
        name = t["name"]
        required_perm = TOOL_PERMISSION_MAP.get(name)
        if required_perm is not None and required_perm not in effective_perms:
            continue
        if name in restricted:
            continue
        filtered.append(t)
    return filtered


# ── ReAct system prompt ───────────────────────────────────────────────────────

def _build_system_prompt_agentic(ctx, specialist_context: str = "") -> str:
    """Build the ReAct system prompt for Crystal with tool-use instructions."""
    from crystalos.lib.constants import CRYSTAL_MAX_TOOL_TURNS
    from crystalos.crystal.registry import TOOL_REGISTRY, get_tools_for_scope

    tools = get_tools_for_scope(ctx.scope)
    tool_list = "\n".join(
        f"- **{t['name']}**: {t['description']}"
        for t in tools
    )

    scope_framing = (
        "You have access to data across all surveys in this organization."
        if ctx.scope == "org"
        else "You have access to this survey's data including responses, insights, and metrics."
    )

    no_text_note = ""
    if not ctx.has_open_text:
        no_text_note = (
            "\n\nIMPORTANT: This survey has no open-text questions. "
            "Never discuss themes, topics, or verbatims. Focus only on score-based metrics."
        )

    specialist_block = f"\n\n## Domain Context\n{specialist_context}" if specialist_context else ""

    from crystalos.crystal.registry import ACTION_TOOL_NAMES, DATA_TOOL_NAMES, ANALYSIS_TOOL_NAMES
    # Filter tools by effective permissions before rendering
    tools = _build_filtered_tool_list(ctx, tools)

    data_tools     = [t for t in tools if t["name"] in DATA_TOOL_NAMES]
    analysis_tools = [t for t in tools if t["name"] in ANALYSIS_TOOL_NAMES]
    action_tools   = [t for t in tools if t["name"] in ACTION_TOOL_NAMES]

    data_tool_list     = "\n".join(f"- **{t['name']}**: {t['description']}" for t in data_tools)
    analysis_tool_list = "\n".join(f"- **{t['name']}**: {t['description']}" for t in analysis_tools)
    action_tool_list   = "\n".join(f"- **{t['name']}**: {t['description']}" for t in action_tools) if action_tools else ""

    analysis_section = f"""
## Analytical Tools (Deep Analysis — prefer these for analytical questions)
These run specialist analysis and return structured findings. Reach for them instead of
raw data tools when the user asks an analytical question:

{analysis_tool_list}
""" if analysis_tools else ""

    action_section = f"""
## Action Tools (Propose-Only — User Confirms Before Execution)
You can propose the following actions. These NEVER execute automatically — they generate
a proposal card the user reviews and confirms. Use them when the user asks what to DO,
not just what the data says.

{action_tool_list}
""" if action_tools else ""

    identity = _build_brand_identity(ctx)
    custom_instructions = _build_custom_instructions(ctx)

    return f"""You are {identity}. You are simultaneously:
- A world-class CX/EX analyst who interprets survey data with deep domain expertise
- A proactive advisor who recommends concrete next steps
- A platform coordinator who can propose surveys, question edits, distribution campaigns, workflows, and alerts (always as confirmable proposals, never executed directly)
{custom_instructions}
{scope_framing}{no_text_note}{specialist_block}

## How You Work (ReAct loop)

You answer by calling tools to gather evidence, then synthesizing. Each turn you respond with
ONE JSON object that is EITHER a set of tool calls OR a signal that you have enough to answer:

To call tools:
{{"thought": "what I need and why", "action": "tool_call",
  "tool_calls": [{{"tool": "<tool_name>", "args": {{"survey_id": "...", ...}}}}]}}

When you have enough data:
{{"thought": "I can answer now", "action": "final",
  "answer": "draft", "citations": [], "suggestions": [], "insight_refs": []}}

Rules:
- Always pass the correct args. If a tool says it requires an argument you don't have
  (e.g. segment_question_id), call the discovery tool first (list_segmentable_questions),
  read the result, THEN call the analysis with a real value.
- If a tool returns an error, read it and either fix the args and retry or pick another tool.
- You may run up to {CRYSTAL_MAX_TOOL_TURNS} tool turns. Stop as soon as you have what you need.
- Do not call the same tool with the same args twice.

## Route the question to the right tool

- "What are people saying / themes / takeaways / what's emerging" → **summarize_themes**
- "Is X improving/declining / what changed over time / trend" → **analyze_trends_over_time**
- "How does it differ by segment / which group is worse" → **analyze_segments** (discover the segment first)
- "What's driving the score / what should we fix to move the needle" → **analyze_key_drivers**
- "Anything I should know / what's important right now" → **proactive_insights**
- "Generate a report / full writeup / readout" → **generate_report**
- "What should I do / next steps" → **recommend_next_actions** (or a specific propose_* tool below)
- A follow-up survey would close a learning gap → **propose_survey_creation**
- The current survey is missing a question that would explain a finding → **propose_survey_edit**
- Response volume/coverage is too low or a segment is under-sampled → **propose_distribution**
- A recurring response pattern should trigger automation → **propose_workflow**
- A metric/topic is crossing a risk threshold worth monitoring → **propose_alert** (e.g. "alert me if NPS drops below 30")
- Specific lookups (one metric, one topic's verbatims, benchmark) → the matching get_* data tool

## Data Tools
{data_tool_list}
{analysis_section}{action_section}
## Tone & Style (applies to your final answer)
- Direct and specific. "NPS is 42 — above the SaaS median of 35" not "your score is decent"
- Ground every claim in tool results. Never fabricate data; if you don't have it, say so.
- For edits/surveys/workflows: always frame as proposals, never commands

Respond with ONLY the JSON object described above — no markdown, no extra text."""


# ── ReAct loop (non-streaming) ────────────────────────────────────────────────

async def _crystal_rate_count(org_id: str) -> int:
    """Increment + return the per-org per-minute Crystal request count. 0 if Redis is down."""
    import os
    import redis.asyncio as _redis_mod
    try:
        r = await _redis_mod.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"))
        try:
            rate_key = f"crystal:{org_id}:rpm"
            count = await r.incr(rate_key)
            if count == 1:
                await r.expire(rate_key, 60)
            return count
        finally:
            await r.aclose()
    except Exception:
        return 0  # Redis not available — skip rate limiting


def _build_ctx(inp: CrystalInput):
    from crystalos.crystal.context import CrystalContext, _resolve_permissions
    brand = None
    if inp.brand_id:
        from crystalos.crystal.context import BrandContext
        brand = BrandContext(
            brand_id=inp.brand_id,
            brand_name=inp.brand_id,
            brand_persona=None,
            data_region="us",
            plan_tier="enterprise",
            permitted_features=frozenset(),
            restricted_features=frozenset(),
            custom_instructions=None,
            support_ticket_url=None,
            feature_request_url=None,
        )
    role = inp.user_role if inp.user_role else "viewer"
    effective_perms = _resolve_permissions(brand, role)
    # tag_ids: prefer the explicit list (group-scope callers); fall back to the
    # singular tag_id (what the backend's scope='tag' request body actually
    # sends — see backend/src/routes/experience.ts) wrapped in a 1-tuple.
    if inp.tag_ids:
        resolved_tag_ids = tuple(inp.tag_ids)
    elif inp.tag_id:
        resolved_tag_ids = (inp.tag_id,)
    else:
        resolved_tag_ids = None
    return CrystalContext(
        org_id=inp.org_id,
        user_id=inp.user_id or 'unknown',
        survey_id=inp.survey_id,
        scope=inp.scope,
        has_open_text=inp.has_open_text,
        tag_ids=resolved_tag_ids,
        brand=brand,
        user_role=role,
        effective_perms=effective_perms,
    )


def _build_history(inp: CrystalInput) -> list[dict]:
    from crystalos.lib.constants import CRYSTAL_CONVERSATION_WINDOW
    return [
        {"role": m["role"], "content": str(m["content"])[:2000]}
        for m in (inp.conversation_history or [])[-CRYSTAL_CONVERSATION_WINDOW * 2:]
        if m.get("role") in ("user", "assistant") and m.get("content")
    ]


def _build_tool_observations(tool_results: list[dict]) -> str:
    """Format accumulated tool results (including errors) for the next ReAct turn."""
    if not tool_results:
        return ""
    lines = ["\n\n## Tool Results So Far"]
    for r in tool_results:
        args = r.get("args") or {}
        arg_str = ", ".join(f"{k}={v}" for k, v in args.items() if k != "survey_id")
        header = f"**{r['tool']}**" + (f" ({arg_str})" if arg_str else "")
        lines.append(f"{header}:\n{_format_tool_result(r['tool'], r['result'])}")
    return "\n".join(lines)


# Action-tool proposal_type → frontend ActionProposal.type. Most pass through;
# a few tool-internal names alias to the canonical frontend handler name.
_PROPOSAL_TYPE_ALIASES = {
    "workflow":      "create_workflow",
    "alert":         "create_alert",
    "case":          "create_case",
    "assign_owner":  "assign_owner",
    "slack_notify":  "send_slack_alert",
    # Insight Pipeline v2 — report proposals → frontend handler names (07 §5)
    "manual_insight_run":          "trigger_manual_insight_run",
    "view_report":                 "view_report",
    "generate_intelligence_report": "generate_intelligence_report",
    # Tag Report proposals → frontend handler names (docs/tag-report). Identity
    # mappings (proposal_type already equals the frontend handler name) — listed
    # explicitly, same convention as view_report/generate_intelligence_report above,
    # so the contract is documented rather than incidental.
    "view_tag_report":             "view_tag_report",
    "generate_tag_report":         "generate_tag_report",
}


def _normalize_proposal(p: dict, turn_id: str | None = None) -> dict:
    """Normalise a tool/skill proposal dict to the frontend ActionProposal shape.

    Tool proposals carry ``proposal_type`` and often lack ``id``/``type``; the
    frontend (and the ActionProposal model) need ``type`` + ``id``. This maps
    the alias, fills a server-minted ``id``, and applies safe defaults so the
    proposal both validates and renders.

    ``id`` doubles as the frontend's ``proposalKey`` (CrystalPanel.tsx sends
    ``proposal.id`` verbatim as ``proposalKey`` — there is no separate field on
    the wire, and the frontend is out of scope to change here). Two properties
    both need to hold for the SAME field:
      1. Genuinely unique per emission — two distinct recommendations (even an
         identically-titled one from a later turn) must NOT collapse onto the
         same crystal_action_proposals row (that was the bug: a bare title
         slug alone is deterministic across turns).
      2. Stable for the lifetime of ONE rendered proposal card — the frontend
         fires emitted -> accepted -> succeeded/failed as separate POSTs of the
         same in-memory ActionProposal object's ``.id``, and those must still
         collapse onto one row (P0-3's dedup fix, migration 20260806000001).
    Scoping the slug by ``turn_id`` (unique per turn, minted before this
    proposal is even built — see _run_skill_stream et al.) satisfies both:
    stable across the object's own lifecycle POSTs (same turn_id + same slug
    each time), unique across turns (different turn_id). Falls back to a bare
    uuid4 when no turn_id is available (legacy/direct callers, tests) — still
    unique, just not turn-scoped.
    """
    import re as _re
    out = dict(p)
    ptype = out.get("type") or out.get("proposal_type") or ""
    out["type"] = _PROPOSAL_TYPE_ALIASES.get(ptype, ptype)
    if not out.get("id"):
        slug = _re.sub(r"[^a-z0-9]+", "-", (out.get("title") or out["type"]).lower()).strip("-")[:48]
        slug = slug or "proposal"
        out["id"] = f"{turn_id}:{slug}" if turn_id else str(uuid.uuid4())
    out.setdefault("priority", "medium")
    out.setdefault("requires_confirmation", True)
    return out


def _extract_action_proposals(tool_results: list[dict], turn_id: str | None = None) -> list[dict]:
    """Pull action proposals out of action-tool results (for the frontend to render)."""
    from crystalos.crystal.registry import ACTION_TOOL_NAMES
    proposals: list[dict] = []
    for tr in tool_results:
        if tr["tool"] in ACTION_TOOL_NAMES:
            result = tr.get("result") or {}
            if isinstance(result, dict):
                if "actions" in result:
                    proposals.extend(
                        _normalize_proposal(a, turn_id=turn_id) for a in result["actions"][:5] if isinstance(a, dict)
                    )
                elif "proposal_type" in result:
                    proposals.append(_normalize_proposal(result, turn_id=turn_id))
    return proposals


def _augment_inp_with_tools(inp: CrystalInput, tool_results: list[dict]) -> CrystalInput:
    """Return a copy of inp with successful tool results injected as assistant context,
    so the final grounded + evaluated synthesis (via _run_crystal) can use them."""
    good = [r for r in tool_results if isinstance(r.get("result"), dict) and "error" not in r["result"]]
    history = list(inp.conversation_history or [])
    if good:
        history.append({
            "role": "assistant",
            "content": "## Retrieved Data\n" + "\n".join(
                f"**{r['tool']}**:\n{_format_tool_result(r['tool'], r['result'])}" for r in good
            ),
        })
    return inp.model_copy(update={"conversation_history": history})


async def _react_plan_tools(inp: CrystalInput, ctx, request=None):
    """Async generator driving the ReAct tool-selection phase.

    Yields ('event', {sse-dict}) as tools run, then finally ('result', [tool_results]).
    The LLM chooses tools AND their arguments each turn; errors are kept so it can correct.
    """
    from crystalos.lib.constants import CRYSTAL_MAX_TOOL_TURNS
    from crystalos.crystal.tools import dispatch_tool

    system = _build_system_prompt_agentic(ctx)
    history = _build_history(inp)
    tool_results: list[dict] = []
    seen: set[tuple] = set()

    for turn in range(CRYSTAL_MAX_TOOL_TURNS):
        if request is not None:
            try:
                if await request.is_disconnected():
                    return
            except Exception:
                pass

        user_content = inp.message + _build_tool_observations(tool_results)
        try:
            step, _ = await call_agent(
                agent_name="crystal",
                system=system,
                user=user_content,
                output_schema=ReActStep,
                prior_messages=history or None,
            )
        except Exception as exc:
            logger.warning("crystal_react_step_failed", turn=turn, error=str(exc))
            break

        calls = step.tool_calls if step.action == "tool_call" else []
        if not calls:
            break  # LLM signalled it has enough — proceed to synthesis

        ran_any = False
        for call in calls[:5]:
            key = (call.tool, json.dumps(call.args or {}, sort_keys=True, default=str))
            if key in seen:
                continue
            seen.add(key)
            args = dict(call.args or {})
            if ctx.survey_id and "survey_id" not in args:
                args["survey_id"] = ctx.survey_id

            yield ("event", {"type": "thinking", "tool": call.tool,
                             "message": f"Running {call.tool.replace('_', ' ')}..."})
            try:
                result = await dispatch_tool(call.tool, ctx, args)
            except Exception as exc:
                result = {"error": str(exc)}
            ran_any = True
            ok = isinstance(result, dict) and "error" not in result
            yield ("event", {"type": "observation", "tool": call.tool,
                             "summary": (("Found data" if ok else result.get("error", "no data")))[:200]})
            tool_results.append({"tool": call.tool, "args": args, "result": result})

        if not ran_any:
            break
        # Stop once we have a few solid results to keep latency bounded
        if len([r for r in tool_results if "error" not in r["result"]]) >= 6:
            break

    yield ("result", tool_results)


async def _run_react_loop(inp: CrystalInput, db_pool=None) -> CrystalOutput:
    """Execute the Crystal ReAct loop — LLM-driven multi-step tool calling, then a
    grounded + evaluated synthesis via _run_crystal (preserving the hallucination filter)."""
    ctx = _build_ctx(inp)

    if await _crystal_rate_count(inp.org_id) > 10:
        raise ValueError("Rate limit exceeded: 10 requests per minute per org")

    tool_results: list[dict] = []
    async for kind, payload in _react_plan_tools(inp, ctx):
        if kind == "result":
            tool_results = payload

    # Skill-first: try the skill framework before the generic Crystal synthesis
    skill_out = await _skill_synthesis(inp, tool_results)
    if skill_out is not None:
        proposals = _extract_action_proposals(tool_results)
        if proposals and not skill_out.action_proposals:
            from pydantic import ValidationError
            coerced = []
            for p in proposals:
                try:
                    coerced.append(ActionProposal(**p) if isinstance(p, dict) else p)
                except ValidationError:
                    continue
            skill_out.action_proposals = coerced
        return skill_out

    augmented = _augment_inp_with_tools(inp, tool_results)
    output = await _run_crystal(augmented)
    proposals = _extract_action_proposals(tool_results)
    if proposals:
        from pydantic import ValidationError
        coerced = []
        for p in proposals:
            try:
                coerced.append(ActionProposal(**p) if isinstance(p, dict) else p)
            except ValidationError:
                continue
        output.action_proposals = coerced
    return output


# ── Skill-first synthesis helpers ─────────────────────────────────────────────

def _routing_hint_for_scope(ctx) -> str:
    """Extra text appended to the semantic-routing query so skill routing has a
    scope-aware signal. ``skill_registry.find`` only takes free text (no explicit
    scope/tag_ids parameter), so a plain user message about a tagged survey
    group ("how's onboarding doing across our surveys") could route to either
    tag-analyst, gap-analyst, or crystal-analyst on pure embedding similarity
    alone. This nudges tag-scoped queries toward tag-analyst without requiring
    changes to the registry's find() signature."""
    if ctx is not None and getattr(ctx, "scope", None) == "tag" and getattr(ctx, "tag_ids", None):
        return " (cross-survey Tag Report question, scoped to one tag/survey group)"
    return ""


async def _resolve_crystal_skill_match(
    registry,
    message: str,
    *,
    top_k: int = 5,
    ctx=None,
) -> tuple[dict | None, float | None]:
    """Return the best skill for Crystal chat, skipping pipeline-only sub-specialists."""
    from crystalos.lib.constants import CRYSTAL_ROUTING_EXCLUDED_SKILLS

    routing_query = message + _routing_hint_for_scope(ctx)
    matches = await registry.find(routing_query, top_k=top_k)
    if not matches:
        name = registry.find_sync(routing_query)
        if name and name not in CRYSTAL_ROUTING_EXCLUDED_SKILLS:
            meta = registry._skills.get(name)
            if meta:
                return meta, 0.5
        return None, None

    for meta, score in matches:
        if meta.get("name") not in CRYSTAL_ROUTING_EXCLUDED_SKILLS:
            return meta, score
    return None, None


def _merged_citation_ids(citations: list | None, insight_refs: list | None) -> list[str]:
    """Merge citations + insight_refs into deduplicated string IDs for SSE/REST."""
    merged: list[str] = []
    seen: set[str] = set()
    for raw in list(citations or []) + list(insight_refs or []):
        cid = str(raw).strip()
        if cid and cid not in seen:
            seen.add(cid)
            merged.append(cid)
    return merged


_SEGMENT_CHART_INSIGHT_CATEGORIES = frozenset(
    {"metric.nps", "metric.csat", "metric.ces", "voice.topic"}
)


def _build_viz_for_citations(
    citations: list[str] | None,
    insight_refs: list[str] | None,
    insights: list[dict] | None,
    tool_results: list[dict] | None,
) -> "VizSpec | None":
    """Tier-0 deterministic chart selection (TRACKER.md decision #2) — never model-chosen.

    Pure function over data this turn has *already fetched*; no LLM call, no
    new query. Tries two chart shapes, in priority order, both requiring a
    ``get_segment_breakdown`` tool result already in this turn's
    ``tool_results`` (the executor at crystal/tools.py:475-543 — the only
    place in the codebase that produces a real per-segment shape;
    ``schemas/insight.py``'s ``segment_json`` column exists in the DB/schema
    but is never populated by any pipeline node, so it is not a usable source
    here):

      1. **nps_bar_chart** — a cited/referenced insight that is an NPS metric
         insight (``category == "metric.nps"`` or ``metric_json.name ==
         "NPS"`` — the two shapes the pipeline actually writes, see
         graphs/insights.py:4803 and graphs/custom_analysis.py:564), plus at
         least one segment carrying ``nps_avg``. Takes priority when both
         ``nps_avg`` and ``avg_sentiment_score`` are available, since it's the
         more specific, directly-named metric.
      2. **sentiment_by_segment_chart** — falls back to this whenever a
         broader metric-category insight is cited (NPS/CSAT/CES/topic — see
         ``_SEGMENT_CHART_INSIGHT_CATEGORIES``) but ``nps_avg`` isn't usable
         (e.g. a CSAT-only or topic-driven turn), using ``avg_sentiment_score``
         — the one per-segment field ``get_segment_breakdown`` always
         populates regardless of metric, unlike ``nps_avg`` which requires
         NPS-scored responses to exist.

    Missing all ingredients returns None — no chart, no error. That's the
    common case (most turns never call ``get_segment_breakdown``), and it must
    stay a silent no-op so it doesn't drag down EVALS `non_empty` scoring on
    chart-free turns (P0-1).
    """
    cited = {str(c) for c in list(citations or []) + list(insight_refs or []) if str(c).strip()}
    if not cited:
        return None

    matched_insight: dict | None = None
    is_nps = False
    for ins in insights or []:
        if str(ins.get("id", "")) not in cited:
            continue
        metric_name = (ins.get("metric_json") or {}).get("name")
        category = ins.get("category")
        if category == "metric.nps" or metric_name == "NPS":
            matched_insight = ins
            is_nps = True
            break
        if matched_insight is None and category in _SEGMENT_CHART_INSIGHT_CATEGORIES:
            matched_insight = ins
    if matched_insight is None:
        return None

    segments: list | None = None
    for tr in tool_results or []:
        if tr.get("tool") != "get_segment_breakdown":
            continue
        candidate = (tr.get("result") or {}).get("segments")
        if isinstance(candidate, list) and candidate:
            segments = candidate
            break
    if not segments:
        return None

    source_id = str(matched_insight.get("id")) if matched_insight.get("id") else None

    if is_nps:
        nps_data = [
            {"segment": str(s.get("segment", "unknown")), "score": float(s["nps_avg"])}
            for s in segments
            if isinstance(s, dict) and s.get("nps_avg") is not None
        ]
        if nps_data:
            return VizSpec(
                kind="nps_bar_chart",
                title=matched_insight.get("headline") or "NPS by Segment",
                data=nps_data,
                source_insight_id=source_id,
            )
        # NPS insight cited but no segment carries nps_avg (e.g. a CSAT-only
        # survey) — fall through to the sentiment shape below rather than
        # returning no chart at all.

    sentiment_data = [
        {"segment": str(s.get("segment", "unknown")), "sentiment_score": float(s["avg_sentiment_score"])}
        for s in segments
        if isinstance(s, dict) and s.get("avg_sentiment_score") is not None
    ]
    if not sentiment_data:
        return None

    return VizSpec(
        kind="sentiment_by_segment_chart",
        title=matched_insight.get("headline") or "Sentiment by Segment",
        data=sentiment_data,
        source_insight_id=source_id,
    )


# ── applied_filters — canonical transparency object ──────────────────────────
# Maps every filter-relevant TOOL_REGISTRY argument name to a (kind, label)
# pair. Verified against the CURRENT crystal/registry.py TOOL_REGISTRY (~60
# tools) — added `segment` (get_xo_context), `report_id` (get_insight_report /
# propose_view_report), and `run_id` (get_tag_report / get_tag_report_trail /
# propose_view_tag_report / propose_generate_tag_report) beyond the original
# design, which didn't yet cover those three. Deliberately excludes pure
# payload/pagination args (limit, title, description, message, webhook_url,
# severity, threshold, priority, confidence, rationale, business_rationale,
# gap_description, gap_type, purpose, target_audience, edit_request,
# trigger_condition, desired_outcome, alert_type, condition, mode, run_mode,
# estimated_credits, label, url, summary, owner_user_id, owner_label,
# role_label, channel) — those describe what an action tool should DO/create,
# not what Crystal scoped/searched, so they never produce an applied_filters
# entry (correctly falling through to the is_action_tool() exclusion below).
_ARG_KIND_MAP: dict[str, tuple[str, str]] = {
    "survey_id": ("survey", "Survey"),
    "checkpoint_id": ("checkpoint", "Checkpoint"),
    "tag_id": ("tag", "Tag"), "tag_ids": ("tag", "Tags"),
    "response_id": ("entity", "Response"), "contact_id": ("entity", "Contact"),
    "account_id": ("entity", "Account"), "case_id": ("entity", "Case"),
    "driver": ("entity", "Driver"), "driver_ref": ("entity", "Driver"),
    "segment_question_id": ("segment", "Segment"), "segment_question_text": ("segment", "Segment"),
    "target_segment": ("segment", "Segment"), "segment": ("segment", "Segment"),
    "department_id": ("segment", "Department"), "department_name": ("segment", "Department"),
    "group_id": ("segment", "Group"), "group_name": ("segment", "Group"), "role_key": ("segment", "Role"),
    "metric": ("metric", "Metric"), "metrics": ("metric", "Metrics"),
    "topic_name": ("topic", "Topic"), "focus_topic": ("topic", "Topic focus"), "focus_area": ("topic", "Topic focus"),
    "sentiment": ("sentiment", "Sentiment"), "layer": ("layer", "Insight layer"), "lane": ("lane", "Lane"),
    "time_window": ("date_range", "Time window"), "days": ("date_range", "Lookback (days)"),
    "lookback": ("date_range", "Lookback"),
    "industry": ("benchmark", "Industry benchmark"),
    "search_query": ("query", "Search"), "query": ("query", "Search"), "concept": ("query", "Search"),
    "report_id": ("report", "Report"), "run_id": ("report", "Report run"),
}
_PAIR_SPECS: list[tuple[str, str, str, str]] = [
    ("survey_id_a", "survey_id_b", "survey", "Surveys compared"),
    ("checkpoint_id_a", "checkpoint_id_b", "checkpoint", "Checkpoints compared"),
    ("window_start", "window_end", "date_range", "Date range"),
]


def build_applied_filters(tool_results: list[dict]) -> list["AppliedFilter"]:
    """Pure function: turn one turn's tool_results into the deduped
    applied_filters list. Call once, after tool_results is fully populated,
    before CrystalOutput/the SSE 'answer' event is built."""
    from crystalos.crystal.registry import is_action_tool
    entries: list[AppliedFilter] = []
    for tr in tool_results:
        tool, args, result = tr.get("tool", ""), tr.get("args") or {}, tr.get("result")
        if not isinstance(result, dict) or "error" in result:
            continue
        one = _normalize_one_call(tool, args, result)
        if not one and not is_action_tool(tool):
            one = [AppliedFilter(kind="query", label="Checked",
                                  value=tool.replace("_", " "), raw=dict(args), sources=[tool])]
        entries.extend(one)
    return _dedupe_filters(entries)


def _normalize_one_call(tool: str, args: dict, result: dict) -> list["AppliedFilter"]:
    out: list[AppliedFilter] = []
    consumed: set[str] = set()
    if "dimension" in args and "match_value" in args:
        dim = str(args["dimension"])
        out.append(AppliedFilter(kind="entity", label=dim.replace("_", " ").title(),
                                  value=str(args["match_value"]),
                                  raw={"dimension": dim, "match_value": args["match_value"]}, sources=[tool]))
        consumed |= {"dimension", "match_value"}
    for a, b, kind, label in _PAIR_SPECS:
        if a in args and b in args and a not in consumed:
            out.append(AppliedFilter(kind=kind, label=label, value=f"{args[a]} → {args[b]}",
                                      raw={a: args[a], b: args[b]}, sources=[tool]))
            consumed |= {a, b}
    for key, (kind, label) in _ARG_KIND_MAP.items():
        if key in consumed or key not in args or args[key] in (None, "", [], {}):
            continue
        out.append(AppliedFilter(kind=kind, label=label,
                                  value=_resolve_friendly_value(key, args[key], result),
                                  raw={key: args[key]}, sources=[tool]))
    return out


def _resolve_friendly_value(key: str, raw_value, result: dict) -> str:
    if key in ("days", "lookback"):
        return f"last {raw_value} days" if key == "days" else f"last {raw_value} checkpoints"
    if isinstance(raw_value, list):
        return ", ".join(str(v) for v in raw_value)
    if key in ("survey_id", "tag_id", "checkpoint_id", "segment_question_id") and isinstance(result, dict):
        for hint_key in ("survey_title", "title", "tag_name", "name"):
            if result.get(hint_key):
                return str(result[hint_key])
        return f"{str(raw_value)[:8]}…"
    return str(raw_value)


def _dedupe_filters(entries: list["AppliedFilter"]) -> list["AppliedFilter"]:
    merged: dict[tuple, AppliedFilter] = {}
    order: list[tuple] = []
    for e in entries:
        first_raw_val = next(iter(e.raw.values()), None)
        key = (e.kind, str(first_raw_val))
        if key in merged:
            existing = merged[key]
            for s in e.sources:
                if s not in existing.sources:
                    existing.sources.append(s)
        else:
            merged[key] = e
            order.append(key)
    return [merged[k] for k in order]


def _derive_viz_and_filters(
    citations: list, insight_refs: list, insights: list, tool_results: list[dict],
) -> tuple["VizSpec | None", list["AppliedFilter"]]:
    """Shared derivation for the two Tier-0 deterministic post-processing
    signals computed from a turn's citations/tool_results — never model-chosen.
    Single call site for both, so a future change to either doesn't have to be
    remembered across every place a CrystalOutput/final answer is built."""
    viz = _build_viz_for_citations(citations, insight_refs, insights, tool_results)
    applied_filters = build_applied_filters(tool_results or [])
    return viz, applied_filters


def _normalize_skill_output(
    output: dict,
    skill_name: str,
    insights: list[dict] | None = None,
    tool_results: list[dict] | None = None,
    turn_id: str | None = None,
) -> "CrystalOutput | None":
    """Map any skill's output dict to CrystalOutput.

    Skills have different output shapes; this function normalises them into the
    common CrystalOutput structure understood by the Crystal conversation layer.
    Returns None if the output cannot be mapped to a usable answer.
    """
    answer = extract_skill_answer(output)
    if not answer:
        return None

    # Enrich answer with bullet points from list fields
    enrichment_lists = output.get("trend_findings") or output.get("themes") or []
    if isinstance(enrichment_lists, list) and enrichment_lists:
        bullets = []
        for f in enrichment_lists[:4]:
            if isinstance(f, dict):
                text = f.get("finding") or f.get("label") or str(f)[:120]
            else:
                text = str(f)[:120]
            bullets.append(f"\u2022 {text}")
        if bullets:
            answer = answer + "\n" + "\n".join(bullets)

    # suggestions
    raw_suggestions = (
        output.get("suggestions")
        or output.get("suggested_lenses")
        or output.get("follow_up")
        or []
    )
    suggestions = normalize_suggestions(raw_suggestions, max_items=3)

    citations = _merged_citation_ids(output.get("citations"), output.get("insight_refs"))
    insight_refs = [str(r).strip() for r in (output.get("insight_refs") or []) if str(r).strip()]

    # action_proposals — normalise (map proposal_type→type, fill id/defaults) so
    # model-emitted proposals validate even when they omit id or use proposal_type.
    action_proposals: list[ActionProposal] = []
    for p in (output.get("action_proposals") or output.get("actions") or [])[:3]:
        try:
            if isinstance(p, dict):
                action_proposals.append(ActionProposal(**_normalize_proposal(p, turn_id=turn_id)))
            else:
                action_proposals.append(p)
        except Exception:
            continue

    viz, applied_filters = _derive_viz_and_filters(citations, insight_refs, insights, tool_results)

    return CrystalOutput(
        answer=answer,
        citations=citations,
        suggestions=suggestions,
        insight_refs=insight_refs,
        action_proposals=action_proposals,
        viz=viz,
        applied_filters=applied_filters,
    )


async def _skill_synthesis(
    inp: "CrystalInput",
    tool_results: list[dict],
    skill_meta: dict | None = None,
    score: float | None = None,
    turn_id: str | None = None,
) -> "CrystalOutput | None":
    """Route synthesis through the skill framework before falling back to _run_crystal.

    Finds the best matching skill for the user's message, executes it with
    unified skill input, and normalises the output. Returns None on any
    failure (missing skill, eval failure, normalisation failure) so the
    caller can fall back to the generic Crystal synthesis.

    If ``skill_meta`` is supplied, routing is skipped — the caller has already
    resolved the best skill (avoids a redundant second embedding/route call
    in the same turn).

    ``turn_id`` is forwarded to _normalize_skill_output so any action
    proposals in the skill's output get turn-scoped, server-minted ids (see
    _normalize_proposal).
    """
    try:
        from crystalos.lib.constants import CRYSTAL_ROUTING_EXCLUDED_SKILLS
        from crystalos.lib.skill_registry import get_registry
        from crystalos.lib.skill_runtime import SkillRuntime

        registry = get_registry()
        if not registry._initialized:
            await registry.initialize()

        # Reuse the caller's already-resolved skill when provided; otherwise route.
        if skill_meta is None:
            skill_meta, score = await _resolve_crystal_skill_match(
                registry, inp.message, ctx=_build_ctx(inp)
            )
            if skill_meta is None:
                return None
        elif skill_meta.get("name") in CRYSTAL_ROUTING_EXCLUDED_SKILLS:
            return None

        if score is None:
            score = 0.0
        skill_name = skill_meta["name"]

        logger.info(
            "crystal_skill_routing",
            skill=skill_name,
            score=round(score, 3),
            message_preview=inp.message[:60],
        )

        # Build a universal skill input that all conversational skills can work with
        tool_result_map = {
            tr["tool"]: tr["result"]
            for tr in tool_results
            if isinstance(tr.get("result"), dict) and "error" not in tr["result"]
        }
        last_turns = [
            {"role": m["role"], "content": str(m["content"])[:800]}
            for m in (inp.conversation_history or [])[-4:]
            if m.get("role") in ("user", "assistant") and m.get("content")
        ]

        nps_score = None
        if inp.metrics:
            nps_block = inp.metrics.get("nps") or {}
            nps_score = nps_block.get("score")

        survey_facts: dict = {
            "survey_id": str(inp.survey_id),
            "response_count": inp.survey_response_count,
            "survey_type": "custom",
            "nps_score": nps_score,
            "top_topics": [
                {
                    "label": t.get("name", ""),
                    "volume": int(t.get("volume", 0) or 0),
                    "sentiment": round(float(t.get("sentiment_score", 0.0) or 0.0), 3),
                }
                for t in (inp.topics or [])[:8]
            ],
        }
        # Wave 15 — Automation Hub builder context, injected directly into the
        # context bundle rather than via a new tool. This data arrives
        # already-fetched by the Node proxy (backend/src/routes/experience.ts)
        # up front, same as `parse_workflow_nl`'s `registry` parameter — there
        # is no live lookup for a tool to perform mid-reasoning, so a tool
        # would just be a pass-through wrapper around a value we already hold.
        # Both keys are omitted entirely (not set to null) when absent, so a
        # skill/eval reading `"workflow_registry" in survey_facts` sees
        # today's exact shape for every non-builder caller.
        if inp.workflow_registry is not None:
            survey_facts["workflow_registry"] = inp.workflow_registry
        if inp.builder_draft is not None:
            survey_facts["builder_draft"] = inp.builder_draft

        skill_input = {
            "message": inp.message,
            "survey_facts": survey_facts,
            "insights": [
                {
                    "id": str(ins.get("id", "")),
                    "category": ins.get("category", ""),
                    "headline": ins.get("headline", ""),
                    "layer": ins.get("layer", ""),
                    "trust_score": ins.get("trust_score"),
                }
                for ins in (inp.insights or [])[:20]
            ],
            "tool_results": tool_result_map,
            "last_turns": last_turns,
            "org_memory_facts": [],
            "context_state": {
                "decisions": [],
                "data_retrieved": {
                    "topics_loaded": bool(inp.topics),
                    "metrics_loaded": bool(inp.metrics),
                    "tools_called": list(tool_result_map.keys()),
                },
            },
        }

        runtime = SkillRuntime()
        ctx_dict = {
            "org_id": inp.org_id,
            "survey_id": inp.survey_id,
            "user_id": inp.user_id,
            "scope": inp.scope,
        }
        result = await runtime.execute(skill_name, skill_meta, skill_input, ctx_dict)

        if not result.eval_passed:
            logger.warning(
                "crystal_skill_eval_failed",
                skill=skill_name,
                score=result.eval_score,
                issues=result.eval_issues[:2],
            )
            return None

        return _normalize_skill_output(result.output, skill_name, inp.insights, tool_results, turn_id=turn_id)

    except Exception as exc:
        logger.warning("crystal_skill_synthesis_error", error=str(exc))
        return None


# ── ReAct loop (streaming) ────────────────────────────────────────────────────

async def _run_react_loop_streaming(inp: CrystalInput, db_pool=None, request=None, debug: bool = False, store_trace: bool = False):
    """Streaming Crystal ReAct loop — yields SSE event JSON strings.

    Args:
        inp: Crystal input (message, survey context, conversation history).
        db_pool: Optional DB pool (unused; kept for signature compatibility).
        request: FastAPI Request object for disconnect detection (G20 fix).
                 When provided, the loop polls is_disconnected() between tool calls.

    Always yields at least one event so the HTTP stream never closes silently.
    Any startup exception (import failure, context error, etc.) is caught and
    emitted as an 'error' event rather than killing the generator silently.
    """
    import json as _json
    import os
    import time as _time

    _t_start = _time.monotonic()

    # Wrap entire body so any exception — including lazy import failures or
    # unexpected runtime errors before the first yield — surfaces as an SSE event.
    try:
        ctx = _build_ctx(inp)
    except Exception as _ctx_exc:
        logger.error("crystal_streaming_context_failed", error=str(_ctx_exc))
        yield _json.dumps({"type": "error", "message": "Crystal context error — please try again."})
        return

    if await _crystal_rate_count(inp.org_id) > 10:
        yield _json.dumps({"type": "error", "message": "Rate limit exceeded"})
        return

    # Minted here, synchronously, before any SSE frame ships — so it's on the
    # wire (turn_id) at the exact same moment it becomes the crystal_turn_events
    # row's real primary key (G1 fix; see _fire_telemetry / turn_publisher.py).
    turn_id = str(uuid.uuid4())

    # ── Debug: emit skill routing scores ──────────────────────────────────────
    if debug:
        try:
            from crystalos.lib.skill_registry import get_registry
            _reg = get_registry()
            _routing = _reg.find_with_scores(inp.message) if hasattr(_reg, "find_with_scores") else []
            if not isinstance(_routing, list):
                import asyncio as _asyncio
                _routing = await _routing if _asyncio.iscoroutine(_routing) else []
            yield _json.dumps({"type": "debug_routing", "routing": _routing})
        except Exception:
            pass

    # ── ReAct tool phase: the LLM chooses tools AND their arguments each turn ──
    _t_tools_start = _time.monotonic()
    tool_results: list[dict] = []
    try:
        async for kind, payload in _react_plan_tools(inp, ctx, request=request):
            if kind == "event":
                yield _json.dumps(payload)
            elif kind == "result":
                tool_results = payload
    except Exception as exc:
        logger.warning("crystal_stream_react_failed", error=str(exc))

    if debug:
        _t_tools_ms = round((_time.monotonic() - _t_tools_start) * 1000)
        yield _json.dumps({"type": "debug_timing", "phase": "tools", "ms": _t_tools_ms})

    # G28 — Cold-start L3 warm: populate survey_facts from the results we just fetched
    # so the next Crystal session is faster. Pipeline publish overwrites with authoritative data.
    good_results = [r for r in tool_results if isinstance(r.get("result"), dict) and "error" not in r["result"]]
    if good_results:
        try:
            _redis_url = os.getenv("REDIS_URL", "")
            if _redis_url:
                import redis.asyncio as _redis_mod
                _r_warm = await _redis_mod.from_url(_redis_url)
                try:
                    from crystalos.lib.memory import get_memory_manager
                    _mm = get_memory_manager(redis=_r_warm)
                    _tool_results_dict = {tr["tool"]: tr["result"] for tr in good_results}
                    await _mm.warm_from_tool_results(inp.survey_id, _tool_results_dict)
                finally:
                    await _r_warm.aclose()
        except Exception as _warm_exc:
            logger.debug("crystal_l3_warm_failed", error=str(_warm_exc))

    yield _json.dumps({"type": "synthesizing", "message": "Putting it all together..."})

    # Action proposals → separate SSE event for the frontend to render as cards
    action_proposals = _extract_action_proposals(tool_results, turn_id=turn_id)
    if action_proposals:
        yield _json.dumps({"type": "action_proposals", "proposals": action_proposals})

    augmented_inp = _augment_inp_with_tools(inp, tool_results)
    _t_synth_start = _time.monotonic()
    # Skill-first: try the skill framework before the generic Crystal synthesis
    skill_out = await _skill_synthesis(inp, tool_results, turn_id=turn_id)
    if skill_out is not None:
        if skill_out.action_proposals and not action_proposals:
            yield _json.dumps({
                "type": "action_proposals",
                "proposals": [p.model_dump() for p in skill_out.action_proposals],
            })
        yield _json.dumps({
            "type": "answer",
            "answer": skill_out.answer,
            "citations": _merged_citation_ids(skill_out.citations, skill_out.insight_refs),
            "insight_refs": skill_out.insight_refs,
            "suggestions": skill_out.suggestions,
            "viz": skill_out.viz.model_dump() if skill_out.viz else None,
            "applied_filters": [f.model_dump() for f in (skill_out.applied_filters or [])],
            "turn_id": turn_id,
        })
        _fire_telemetry(
            inp, ctx, None, skill_out, tool_results,
            round((_time.monotonic() - _t_start) * 1000), turn_id,
        )
    else:
        final: CrystalOutput | None = None
        try:
            final = await _run_crystal(augmented_inp)
            # _run_crystal has no tool_results/insights of its own — augmented_inp
            # folded tool_results into prose history, so the structured data this
            # deterministic check needs is only available out here.
            viz, applied_filters = _derive_viz_and_filters(final.citations, final.insight_refs, inp.insights, tool_results)
            yield _json.dumps({
                "type": "answer",
                "answer": final.answer,
                "citations": _merged_citation_ids(final.citations, final.insight_refs),
                "insight_refs": final.insight_refs,
                "suggestions": final.suggestions,
                "viz": viz.model_dump() if viz else None,
                "applied_filters": [f.model_dump() for f in applied_filters],
                "turn_id": turn_id,
            })
        except Exception as exc:
            logger.error("crystal_stream_final_failed", error=str(exc))
            yield _json.dumps({"type": "error", "message": "Failed to generate answer"})
        _fire_telemetry(
            inp, ctx, None, final, tool_results,
            round((_time.monotonic() - _t_start) * 1000), turn_id,
        )

    if debug:
        _t_total_ms = round((_time.monotonic() - _t_start) * 1000)
        _t_synth_ms = round((_time.monotonic() - _t_synth_start) * 1000)
        yield _json.dumps({"type": "debug_timing", "phase": "synthesis", "ms": _t_synth_ms})
        yield _json.dumps({"type": "debug_timing", "phase": "total", "ms": _t_total_ms})

        if store_trace:
            try:
                import asyncio as _asyncio
                from crystalos.lib import db as _db

                async def _write_trace():
                    await _db.execute_query(
                        """INSERT INTO crystal_debug_traces
                           (org_id, brand_id, trace)
                           VALUES (%s, %s, %s)""",
                        (
                            inp.org_id,
                            inp.brand_id,
                            _json.dumps({
                                "query":       inp.message[:500],
                                "survey_id":   inp.survey_id,
                                "user_id":     inp.user_id,
                                "tool_count":  len(tool_results),
                                "total_ms":    _t_total_ms,
                                "tool_results": tool_results,
                            }),
                        ),
                    )

                _asyncio.create_task(_write_trace())
            except Exception:
                pass


async def _fetch_skill_context(
    inp: CrystalInput,
    skill_meta: dict,
    ctx,
) -> list[dict]:
    """Call a small targeted set of Crystal tools for a skill — no LLM guidance needed.

    Replaces the multi-turn LLM tool-selection loop with deterministic direct calls.
    Picks at most 3 tools from the skill's allowed_tools list in priority order.
    """
    from crystalos.crystal.tools import dispatch_tool

    allowed: set[str] = set(skill_meta.get("allowed_tools", []))
    tool_results: list[dict] = []

    if getattr(ctx, "scope", None) == "tag" and getattr(ctx, "tag_ids", None):
        # Tag scope: prefetch tag-analyst's tools with tag_id/tag_ids args instead
        # of the survey-scoped PRIORITY list below (this skill has no survey_id).
        tag_id = ctx.tag_ids[0]
        TAG_PRIORITY: list[str] = [
            "get_tag_report", "get_group_topics", "get_group_metrics", "get_tag_report_trail",
        ]
        candidates = [t for t in TAG_PRIORITY if t in allowed][:3]
        for tool_name in candidates:
            args: dict = (
                {"tag_id": tag_id} if tool_name in ("get_tag_report", "get_tag_report_trail")
                else {"tag_ids": list(ctx.tag_ids)}
            )
            try:
                result = await dispatch_tool(tool_name, ctx, args)
                if isinstance(result, dict) and "error" not in result:
                    tool_results.append({"tool": tool_name, "args": args, "result": result})
            except Exception as exc:
                logger.debug("skill_context_tool_failed", tool=tool_name, error=str(exc))
        return tool_results

    # Tools to call in priority order — lightweight first
    PRIORITY: list[str] = [
        "get_survey_overview",
        "get_insights_list",
        "get_topic_details",
        "get_metric_history",
        "get_driver_analysis",
        "get_verbatims",
    ]

    candidates = [t for t in PRIORITY if t in allowed][:3]

    for tool_name in candidates:
        args: dict = {"survey_id": inp.survey_id}
        # get_topic_details needs a topic name — pick the top one
        if tool_name == "get_topic_details" and inp.topics:
            args["topic"] = inp.topics[0].get("name", "")
        try:
            result = await dispatch_tool(tool_name, ctx, args)
            if isinstance(result, dict) and "error" not in result:
                tool_results.append({"tool": tool_name, "args": args, "result": result})
        except Exception as exc:
            logger.debug("skill_context_tool_failed", tool=tool_name, error=str(exc))

    return tool_results


async def _run_skill_loop(inp: CrystalInput) -> CrystalOutput:
    """Skill-first Crystal path — no LLM-driven ReAct loop.

    1. Rate check
    2. Fetch targeted tool context (deterministic, 1-3 direct tool calls)
    3. Route synthesis to best matching skill via SkillRuntime
    4. Fallback: single-shot _run_crystal synthesis (NOT the ReAct loop)

    REST counterpart of _run_skill_stream — same turn_id contract: minted
    synchronously before returning, set on the CrystalOutput, and used as the
    crystal_turn_events row's id, so /insights/crystal's response carries the
    same turn_id its telemetry row was written with (G1 fix).
    """
    import time as _time

    if await _crystal_rate_count(inp.org_id) > 10:
        raise ValueError("Rate limit exceeded: 10 requests per minute per org")

    turn_id = str(uuid.uuid4())
    _t_start = _time.monotonic()
    ctx = _build_ctx(inp)

    # Pre-fetch tool context (best-effort — skill still runs if tools fail)
    tool_results: list[dict] = []
    skill_meta_hint: dict | None = None
    skill_route_score: float | None = None
    try:
        from crystalos.lib.skill_registry import get_registry
        registry = get_registry()
        if not registry._initialized:
            await registry.initialize()
        matches = await _resolve_crystal_skill_match(registry, inp.message, ctx=ctx)
        if matches[0] is not None:
            skill_meta_hint, skill_route_score = matches
            tool_results = await _fetch_skill_context(inp, skill_meta_hint, ctx)
    except Exception as exc:
        logger.debug("skill_loop_prefetch_failed", error=str(exc))

    # Reuse the skill resolved above — avoids a redundant second route call.
    skill_out = await _skill_synthesis(
        inp, tool_results, skill_meta=skill_meta_hint, score=skill_route_score, turn_id=turn_id
    )
    latency_ms = round((_time.monotonic() - _t_start) * 1000)
    if skill_out is not None:
        skill_out.turn_id = turn_id  # mutate in place — callers may hold this exact reference
        _fire_telemetry(inp, ctx, skill_meta_hint, skill_out, tool_results, latency_ms, turn_id)
        return skill_out

    # Fallback: single-shot Crystal synthesis
    augmented = _augment_inp_with_tools(inp, tool_results)
    final = await _run_crystal(augmented)
    final.viz, final.applied_filters = _derive_viz_and_filters(final.citations, final.insight_refs, inp.insights, tool_results)
    final.turn_id = turn_id
    _fire_telemetry(inp, ctx, None, final, tool_results, latency_ms, turn_id)
    return final


def _fire_telemetry(
    inp: "CrystalInput",
    ctx,
    skill_meta: "dict | None",
    output: "CrystalOutput | None",
    tool_results: "list[dict]",
    latency_ms: int,
    turn_id: str,
) -> None:
    """Fire-and-forget telemetry: turn event + product signal detection.

    ``turn_id`` must be the exact value already sent to the client on the
    `answer` SSE frame / REST payload — it becomes crystal_turn_events.id, so
    the row this write produces is addressable by the id the client already
    has (G1 fix; see turn_publisher.TurnEvent).
    """
    import asyncio
    skill_name = skill_meta["name"] if skill_meta else None
    try:
        from crystalos.lib.turn_publisher import TurnEvent, publish_turn_event, detect_quality_signal
        try:
            from crystalos.lib.constants import CRYSTALOS_VERSION
        except ImportError:
            # TODO: wire crystalos_version once available
            CRYSTALOS_VERSION = None
        event = TurnEvent(
            id=turn_id,
            org_id=inp.org_id,
            brand_id=ctx.brand.brand_id if getattr(ctx, "brand", None) else None,
            user_id=inp.user_id or "anonymous",
            survey_id=inp.survey_id,
            thread_id=None,   # nullable after migration 009
            turn_index=0,
            query=inp.message[:500],
            tools_called=[{"tool": r["tool"], "args": r.get("args")} for r in tool_results],
            tool_errors=[
                {"tool": r["tool"], "error": r["result"]["error"]}
                for r in tool_results
                if isinstance(r.get("result"), dict) and "error" in r["result"]
            ],
            eval_score=output.eval_score if output and hasattr(output, "eval_score") else None,
            model_used=None,
            tokens_in=0,
            tokens_out=0,
            latency_ms=latency_ms,
            specialist_used=skill_name,
            skill_name=skill_name,
            quality_signal=detect_quality_signal(inp.message),
            crystalos_version=CRYSTALOS_VERSION,
        )
        # Synchronous by design — it schedules its own task internally. Do not wrap
        # in create_task(); that passes None to create_task() and raises TypeError.
        publish_turn_event(event, ctx)
    except Exception:
        pass
    try:
        from crystalos.lib.feedback_detector import detect_and_route_signal, persist_signal

        async def _detect_persist(msg: str, _ctx) -> None:
            signal = await detect_and_route_signal(msg, _ctx)
            if signal:
                await persist_signal(signal, _ctx)

        asyncio.create_task(_detect_persist(inp.message, ctx))
    except Exception:
        pass


# ── Wave 18 — message-content force-route to workflow-analyst ────────────────
# The reported bug: "What types of trigger exists?" asked from a NON-builder
# page (surface="insights", the default) falls through to normal semantic
# routing, lands on crystal-analyst (survey-data skill), and hallucinates —
# it has zero knowledge of the workflow trigger/action/condition taxonomy and
# will cite whatever survey data happens to be in context regardless of
# relevance. See docs/automation-hub/TRACKER.md Wave 18 for the full 3-layer
# root-cause writeup.
#
# This is a SECOND, independent hard-force condition alongside Wave 15's
# `surface == "workflow_builder"` — that one is a PAGE-CONTEXT signal (works
# from the builder regardless of message wording); this one is a
# MESSAGE-CONTENT signal (works from ANY page, but only for messages that are
# unambiguously reference/taxonomy questions about triggers/actions/
# conditions, not automation-intent or survey-data questions).
#
# Precision/recall tradeoff — deliberately precision-first:
# A false positive here (a normal survey-data question wrongly force-routed
# to workflow-analyst) is its own regression: the user asks e.g. "why did NPS
# drop" and gets bounced to a skill that knows nothing about their data. A
# false negative (a taxonomy question that slips past the detector) is a much
# softer failure — it falls through to normal semantic routing, which now ALSO
# has a fighting chance thanks to the new routing examples added to
# workflow-analyst/SKILL.md this same wave (defense-in-depth). So the detector
# is written as a narrow allowlist of structural patterns, not a broad
# keyword/topic net:
#   1. "what/which type(s)/kind(s) of <trigger|action|condition|automation|
#      workflow>(s)" — the exact reported phrasing family ("what types of
#      trigger exists", "which kinds of actions are there").
#   2. "list/show (me) the/all available <trigger|action|condition>s" —
#      enumeration requests.
#   3. "what scopes/conditions/operators can I use" — reference questions
#      about the condition-builder vocabulary.
#   4. "what does `<dotted.registry.name>` do/mean" — a literal registry-shaped
#      token (category.action, e.g. `flow.delay`, `crystal.sentiment_spike`)
#      is present, which is a very strong, low-false-positive signal — no
#      other Crystal skill's domain would ever plausibly need to explain it.
# Each pattern requires BOTH a taxonomy noun (trigger/action/condition/
# workflow/automation/scope/operator) AND a question-shaped/enumeration verb
# structure — a message containing only "trigger" or only "action" in passing
# (e.g. "the action I took was...") will not match. This mirrors Wave 15's own
# reasoning for why a hard force is safe here: the signal, when it matches, is
# structurally unambiguous, not a fuzzy topic guess.
_WORKFLOW_TAXONOMY_NOUN = r"(?:triggers?|actions?|conditions?|automations?|workflows?|scopes?|operators?)"

_WORKFLOW_TAXONOMY_PATTERNS: tuple[re.Pattern, ...] = (
    # "what/which type(s)/kind(s) of trigger(s)/action(s)/... exist(s)/are there/can I use"
    re.compile(
        rf"\b(?:what|which)\s+(?:types?|kinds?)\s+of\s+{_WORKFLOW_TAXONOMY_NOUN}\b",
        re.IGNORECASE,
    ),
    # "list/show (me) (the/all) available trigger(s)/action(s)/..."
    re.compile(
        rf"\b(?:list|show\s+me)\b.{{0,20}}\b{_WORKFLOW_TAXONOMY_NOUN}\b",
        re.IGNORECASE,
    ),
    # "what scopes/conditions/operators/triggers/actions can I use"
    re.compile(
        rf"\bwhat\s+{_WORKFLOW_TAXONOMY_NOUN}\s+(?:can|could)\s+i\s+use\b",
        re.IGNORECASE,
    ),
    # "what does <registry.dotted.name> do/mean" — a literal dotted registry
    # token (e.g. flow.delay, crystal.sentiment_spike, notify.slack) is a
    # near-zero-false-positive signal on its own: no other skill's domain uses
    # this "category.snake_case" vocabulary.
    re.compile(
        r"\bwhat\s+does\s+`?[a-z_]+\.[a-z_]+`?\s+(?:do|mean)\b",
        re.IGNORECASE,
    ),
)


def _is_workflow_taxonomy_question(message: str) -> bool:
    """True for factual/reference questions about the workflow trigger/action/
    condition taxonomy (e.g. "What types of trigger exists?", "What does
    flow.delay do?") — the message-content force-route condition added in
    Wave 18, independent of `inp.surface`. See the block comment above for the
    precision-first pattern design and false-positive/false-negative tradeoff.
    """
    if not message or not isinstance(message, str):
        return False
    return any(p.search(message) for p in _WORKFLOW_TAXONOMY_PATTERNS)


def _resolve_forced_skill(inp: CrystalInput, registry) -> dict | None:
    """Return the workflow-analyst skill meta if ANY hard-force condition for
    this turn is met, else None (caller falls through to normal semantic
    routing). Two independent conditions currently force workflow-analyst:

    1. Page context (Wave 15): `inp.surface == "workflow_builder"` — the user
       opened Crystal from the Automation Hub builder.
    2. Message content (Wave 18): `_is_workflow_taxonomy_question(inp.message)`
       — the user asked a factual/reference question about the trigger/
       action/condition taxonomy, regardless of what page they're on.

    Centralizing the "does any force condition match" check here (rather than
    inlining a second `if` next to Wave 15's) keeps `_run_skill_stream` a
    simple `if forced: matches = [(forced, 1.0)]` and makes a future third
    force condition a one-line addition to this function instead of another
    copy of the surrounding plumbing.
    """
    if inp.surface == "workflow_builder" or _is_workflow_taxonomy_question(inp.message):
        return registry._skills.get("workflow-analyst")
    return None


async def _run_skill_stream(
    inp: CrystalInput,
    request=None,
    debug: bool = False,
    store_trace: bool = False,
):
    """Skill-first Crystal streaming path — retires the LLM-driven ReAct loop.

    Yields SSE event JSON strings. Flow:
    1. Rate check
    2. Find best skill + fetch targeted tool context (direct calls, no LLM tool selection)
    3. Emit tool events to show activity in the frontend
    4. Route synthesis to SkillRuntime
    5. Fallback to _run_crystal if skill fails

    The legacy _run_react_loop_streaming is preserved for admin debug access
    via the ?legacy=true query param.
    """
    import json as _json
    import time as _time

    _t_start = _time.monotonic()

    try:
        ctx = _build_ctx(inp)
    except Exception as _ctx_exc:
        logger.error("crystal_skill_stream_context_failed", error=str(_ctx_exc))
        yield _json.dumps({"type": "error", "message": "Crystal context error — please try again."})
        return

    if await _crystal_rate_count(inp.org_id) > 10:
        yield _json.dumps({"type": "error", "message": "Rate limit exceeded"})
        return

    # Minted here, synchronously, before any SSE frame ships — so it's on the
    # wire (turn_id) at the exact same moment it becomes the crystal_turn_events
    # row's real primary key (G1 fix; see _fire_telemetry / turn_publisher.py).
    turn_id = str(uuid.uuid4())

    # ── Find best skill and pre-fetch its context ─────────────────────────────
    skill_meta_hint: dict | None = None
    skill_route_score: float | None = None
    tool_results: list[dict] = []

    try:
        from crystalos.lib.skill_registry import get_registry
        registry = get_registry()
        if not registry._initialized:
            await registry.initialize()

        # routing_query (message + tag-scope hint) feeds BOTH semantic-routing
        # fallback paths below (registry.find and, further down,
        # registry.find_sync) — it is not itself a routing decision, just the
        # text ordinary semantic routing considers when no hard force applies.
        routing_query = inp.message + _routing_hint_for_scope(ctx)
        matches: list[tuple[dict, float]] = []

        # Hard-force to workflow-analyst when ANY force condition matches —
        # bypasses semantic routing entirely rather than just biasing it,
        # because in both cases the correct skill is already known, not
        # guessed from ambiguous message text the way ordinary Crystal routing
        # has to. See `_resolve_forced_skill` for the two independent
        # conditions (Wave 15 page-context, Wave 18 message-content) and why a
        # hard force is safe for each. Falls through to normal (tag-scope-
        # aware) semantic routing below if the skill is somehow unregistered,
        # or if neither force condition matches (inp.surface == "insights"/
        # "tag" AND no taxonomy-question match — the overwhelming majority,
        # unchanged since before Wave 15).
        forced_meta = _resolve_forced_skill(inp, registry)
        if forced_meta:
            matches = [(forced_meta, 1.0)]

        # Wave 18 — registry-population gap. `workflow_registry` today is only
        # ever populated by the Node proxy (`backend/src/routes/experience.ts`)
        # when `surface == "workflow_builder"` (Wave 15's condition, unchanged
        # by this wave). A taxonomy question asked from a NON-builder page
        # (the exact bug being fixed) force-routes to workflow-analyst above
        # but arrives with `workflow_registry=None` — without this, the skill
        # would follow its own SKILL.md instruction to "not guess the catalog"
        # and give a hedged, low-value answer instead of the concrete one the
        # user needs, which would not actually fix the reported hallucination
        # complaint (a hedge is better than a hallucination, but still not a
        # real fix). CrystalOS has no independent DB/Node-callback path to
        # fetch the LIVE, org-accurate registry itself (confirmed: `lib/db.py`
        # has no survey/tag registry query, and `workflow_registry` is
        # documented as Node-fetched-and-forwarded, not independently
        # queryable — see workflow-analyst/SKILL.md's compatibility note). So
        # this substitutes the same conservative, code-defined
        # `FALLBACK_REGISTRY` that `execute_propose_workflow` already uses for
        # its own no-live-registry case (`crystal/workflow_nl.py`) — a real,
        # registry-grounded (if smaller/staler) catalog rather than nothing.
        # This does NOT close the gap for `surveys`/`tags` scope data (org-
        # specific, not code-defined) — only the trigger/condition/action
        # taxonomy itself, which is exactly what "what types of trigger
        # exists" needs. Getting the FULL org-accurate registry (including
        # scope) onto this path requires widening the Node proxy's
        # `isBuilderContext` condition to also cover this detector firing —
        # tracked as a follow-up for Nina, not done here (CrystalOS-only wave).
        if (
            forced_meta is not None
            and inp.surface != "workflow_builder"
            and inp.workflow_registry is None
        ):
            from crystalos.crystal.workflow_nl import FALLBACK_REGISTRY
            inp = inp.model_copy(update={"workflow_registry": FALLBACK_REGISTRY})

        if not matches:
            matches = await registry.find(routing_query, top_k=1)
        if not matches:
            name = registry.find_sync(routing_query)
            if name:
                meta = registry._skills.get(name)
                if meta:
                    matches = [(meta, 0.5)]

        if matches:
            skill_meta_hint, skill_route_score = matches[0]
            if debug:
                yield _json.dumps({
                    "type": "debug_routing",
                    "path": "skill",
                    "skill": skill_meta_hint["name"],
                    "score": round(skill_route_score, 3),
                })

            # Fetch targeted tool context — emit thinking/observation events
            from crystalos.crystal.tools import dispatch_tool
            allowed: set[str] = set(skill_meta_hint.get("allowed_tools", []))
            is_tag_scope = ctx.scope == "tag" and ctx.tag_ids
            if is_tag_scope:
                PRIORITY = ["get_tag_report", "get_group_topics", "get_group_metrics", "get_tag_report_trail"]
            else:
                PRIORITY = ["get_survey_overview", "get_insights_list", "get_topic_details",
                            "get_metric_history", "get_driver_analysis", "get_verbatims"]
            candidates = [t for t in PRIORITY if t in allowed][:3]

            for tool_name in candidates:
                if request is not None:
                    try:
                        if await request.is_disconnected():
                            return
                    except Exception:
                        pass

                if is_tag_scope:
                    tag_id = ctx.tag_ids[0]
                    args: dict = (
                        {"tag_id": tag_id} if tool_name in ("get_tag_report", "get_tag_report_trail")
                        else {"tag_ids": list(ctx.tag_ids)}
                    )
                else:
                    args = {"survey_id": inp.survey_id}
                    if tool_name == "get_topic_details" and inp.topics:
                        args["topic"] = inp.topics[0].get("name", "")

                yield _json.dumps({
                    "type": "thinking",
                    "tool": tool_name,
                    "message": f"Fetching {tool_name.replace('_', ' ')}...",
                })
                try:
                    result = await dispatch_tool(tool_name, ctx, args)
                    ok = isinstance(result, dict) and "error" not in result
                    if ok:
                        tool_results.append({"tool": tool_name, "args": args, "result": result})
                    yield _json.dumps({
                        "type": "observation",
                        "tool": tool_name,
                        "summary": ("Found data" if ok else result.get("error", "no data"))[:200],
                    })
                except Exception as exc:
                    yield _json.dumps({"type": "observation", "tool": tool_name, "summary": "error"})

    except Exception as exc:
        logger.debug("skill_stream_routing_failed", error=str(exc))

    yield _json.dumps({"type": "synthesizing", "message": "Analyzing with Crystal skills..."})

    # Reuse the skill resolved above — avoids a redundant second route/embedding call.
    skill_out = await _skill_synthesis(
        inp, tool_results, skill_meta=skill_meta_hint, score=skill_route_score, turn_id=turn_id
    )
    latency_ms = round((_time.monotonic() - _t_start) * 1000)

    if skill_out is not None:
        if skill_out.action_proposals:
            yield _json.dumps({
                "type": "action_proposals",
                "proposals": [p.model_dump() for p in skill_out.action_proposals],
            })
        if debug:
            yield _json.dumps({"type": "debug_timing", "phase": "total", "ms": latency_ms})
        yield _json.dumps({
            "type": "answer",
            "answer": skill_out.answer,
            "citations": _merged_citation_ids(skill_out.citations, skill_out.insight_refs),
            "insight_refs": skill_out.insight_refs,
            "suggestions": skill_out.suggestions,
            "viz": skill_out.viz.model_dump() if skill_out.viz else None,
            "applied_filters": [f.model_dump() for f in (skill_out.applied_filters or [])],
            "turn_id": turn_id,
        })
        _fire_telemetry(inp, ctx, skill_meta_hint, skill_out, tool_results, latency_ms, turn_id)
        return

    # Fallback: single-shot Crystal synthesis (not the ReAct loop)
    final: CrystalOutput | None = None
    try:
        augmented = _augment_inp_with_tools(inp, tool_results)
        final = await _run_crystal(augmented)
        # Same reasoning as the legacy stream's fallback branch — _run_crystal
        # only sees prose-folded history, so recompute from the structured data
        # this generator still holds (inp.insights + tool_results).
        viz, applied_filters = _derive_viz_and_filters(final.citations, final.insight_refs, inp.insights, tool_results)
        yield _json.dumps({
            "type": "answer",
            "answer": final.answer,
            "citations": _merged_citation_ids(final.citations, final.insight_refs),
            "insight_refs": final.insight_refs,
            "suggestions": final.suggestions,
            "viz": viz.model_dump() if viz else None,
            "applied_filters": [f.model_dump() for f in applied_filters],
            "turn_id": turn_id,
        })
    except Exception as exc:
        logger.error("crystal_skill_stream_fallback_failed", error=str(exc))
        yield _json.dumps({"type": "error", "message": "Failed to generate answer"})
    _fire_telemetry(inp, ctx, None, final, tool_results, latency_ms, turn_id)


class CrystalAgent:
    """Thin agent wrapper — no BaseAgent needed since Crystal isn't in the graph."""

    async def run(self, inp: CrystalInput) -> tuple[CrystalOutput, list[dict]]:
        # Primary path: skill framework (no LLM-driven ReAct tool selection).
        # Fallback: single-shot _run_crystal synthesis.
        try:
            output = await _run_skill_loop(inp)
        except ValueError:
            raise  # rate limit — surface to caller
        except Exception as exc:
            logger.warning("crystal_skill_loop_fallback", error=str(exc))
            # _run_skill_loop raised before minting its own turn_id (or before
            # anything else useful ran) — mint one here too, best-effort, so this
            # rarer double-fallback still returns a turn_id backed by a real row
            # rather than a dangling one. Never let telemetry failure here mask
            # the actual answer.
            turn_id = str(uuid.uuid4())
            output = await _run_crystal(inp)
            output.turn_id = turn_id
            try:
                _fire_telemetry(inp, _build_ctx(inp), None, output, [], 0, turn_id)
            except Exception:
                pass
        return output, []


# Module-level singleton
crystal_agent = CrystalAgent()
