"""Response Generator Agent — creates realistic synthetic survey responses.

Given a survey's questions and structure, this agent:
  1. Builds a persona distribution (promoters / passives / detractors based on persona_mix)
  2. Generates batches of realistic answers per persona
  3. Returns complete response objects ready to be inserted into the DB

Called via: POST /responses/generate (agents/main.py)
Triggered by: POST /api/surveys/:surveyId/generate-sample-responses (backend)
"""
from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel, Field, model_validator

from crystalos.lib.openrouter import call_agent
from crystalos.lib.logger import logger


# ── I/O schemas ───────────────────────────────────────────────────────────────

class ResponseGenInput(BaseModel):
    survey_id:     str
    org_id:        str
    survey_title:  str
    survey_intent: str | None = None
    questions:     list[dict]
    count:         int    = Field(default=20, ge=1, le=100)
    persona_mix:   str    = "realistic"   # realistic | critical | positive | mixed


class GeneratedAnswer(BaseModel):
    questionId: str
    type:       str
    value:      Any  # int | str | list[str] | dict | None


class GeneratedResponse(BaseModel):
    persona:   str = ""
    nps_score: int | None = None
    answers:   list[GeneratedAnswer]

    @model_validator(mode="after")
    def _extract_nps(self) -> "GeneratedResponse":
        if self.nps_score is None:
            for a in self.answers:
                if a.type == "nps" and isinstance(a.value, (int, float)):
                    self.nps_score = int(a.value)
                    break
        return self


class ResponseGenBatch(BaseModel):
    responses: list[GeneratedResponse]


# ── Prompt building ───────────────────────────────────────────────────────────

_PERSONA_GUIDES_NPS = {
    "realistic": "~25% detractors (NPS 0-6), 35% passives (NPS 7-8), 40% promoters (NPS 9-10). Mix of frustrations and praise.",
    "critical":  "~60% detractors (NPS 0-6), 30% passives (NPS 7-8), 10% promoters. Focus on pain points, bugs, slow service.",
    "positive":  "~5% detractors, 20% passives (NPS 7-8), 75% promoters (NPS 9-10). Enthusiastic users, feature love.",
    "mixed":     "Equal spread across all NPS ranges 0-10. Highly varied feedback topics.",
}

_PERSONA_GUIDES_CSAT = {
    "realistic": "~20% dissatisfied (1-2/5), 30% neutral (3/5), 50% satisfied (4-5/5). Mix of frustrations and praise.",
    "critical":  "~55% dissatisfied (1-2/5), 30% neutral (3/5), 15% satisfied. Focus on pain points and unmet expectations.",
    "positive":  "~5% dissatisfied, 20% neutral, 75% satisfied (4-5/5). Happy, enthusiastic respondents.",
    "mixed":     "Equal spread across all satisfaction levels 1-5. Highly varied feedback.",
}

_PERSONA_GUIDES_GENERIC = {
    "realistic": "Realistic distribution of satisfied, neutral, and dissatisfied respondents. Mix of frustrations and praise.",
    "critical":  "Majority dissatisfied. Focus on pain points, bugs, slow service.",
    "positive":  "Majority satisfied. Enthusiastic, positive respondents.",
    "mixed":     "Equal spread of positive, neutral, and negative responses. Highly varied.",
}

_ANSWER_RULES = """\
ANSWER FORMAT BY QUESTION TYPE (must match exactly):
- nps:             integer 0-10
- csat:            integer 1-5
- rating:          integer from 1 to scaleMax (shown in question)
- slider:          integer between min and max (shown in question)
- multiple_choice: exactly ONE string copied verbatim from OPTIONS list
- checkbox:        JSON array of strings from OPTIONS (respect maxSelections if shown; default 1-3)
- dropdown:        exactly ONE string copied verbatim from OPTIONS list
- ranking:         JSON array containing ALL option strings in ranked order (most to least preferred)
- open_text:       1-3 sentences (50-200 chars), persona-appropriate; if validation=email produce a realistic email address; if validation=url produce a realistic URL; if validation=phone produce a phone number
- short_text:      3-12 words matching the persona tone (email/url/phone if validation shown)
- matrix (radio):  JSON object mapping EVERY row label to exactly one column label: {"row": "col"}
- matrix (checkbox): JSON object mapping EVERY row label to a JSON array of selected column labels: {"row": ["col1","col2"]}
- date (date):     "YYYY-MM-DD" string
- date (time):     "HH:MM" string (24-hour)
- date (datetime): "YYYY-MM-DDTHH:MM" string
- statement:       null"""


def _format_questions(questions: list[dict]) -> str:
    lines: list[str] = []
    for q in questions:
        qid   = q.get("id", "?")
        qtype = q.get("type", "open_text")
        text  = q.get("question", "")[:120]
        line  = f"  [{qid}] ({qtype}) {text}"

        if qtype in ("multiple_choice", "checkbox", "dropdown", "ranking"):
            opts = q.get("options") or []
            if opts:
                line += f"\n    OPTIONS: {json.dumps(opts)}"
            max_sel = q.get("maxSelections")
            if qtype == "checkbox" and max_sel:
                line += f"  maxSelections={max_sel}"
            allow_other = q.get("allowOther")
            if allow_other:
                line += "  (allowOther: may also generate a custom answer string)"

        if qtype == "rating":
            line += f"  scaleMax={q.get('scaleMax', 5)}"

        if qtype == "slider":
            line += f"  min={q.get('min', 0)} max={q.get('max', 10)}"

        if qtype == "matrix":
            rows = q.get("rows") or []
            cols = q.get("columns") or []
            matrix_type = q.get("matrixType", "radio")
            line += f"  matrixType={matrix_type}"
            line += f"\n    ROWS: {json.dumps(rows)}  COLS: {json.dumps(cols)}"

        if qtype == "date":
            date_type = q.get("dateType", "date")
            line += f"  dateType={date_type}"

        if qtype in ("open_text", "short_text"):
            validation = q.get("validation")
            if validation:
                line += f"  validation={validation}"

        lines.append(line)
    return "\n".join(lines)


def _persona_guide(inp: ResponseGenInput) -> str:
    types = {q.get("type") for q in inp.questions}
    if "nps" in types:
        guides = _PERSONA_GUIDES_NPS
    elif "csat" in types:
        guides = _PERSONA_GUIDES_CSAT
    else:
        guides = _PERSONA_GUIDES_GENERIC
    return guides.get(inp.persona_mix, guides["realistic"])


def _build_system(inp: ResponseGenInput, batch_n: int, offset: int) -> str:
    persona_guide = _persona_guide(inp)
    intent_line   = f'Survey intent: "{inp.survey_intent}"' if inp.survey_intent else ""
    questions_str = _format_questions(inp.questions)

    # Use real question IDs in the example so the LLM doesn't invent ids like "q1"
    first_q   = inp.questions[0] if inp.questions else {}
    ex_qid    = first_q.get("id", "QUESTION_ID_FROM_LIST")
    ex_type   = first_q.get("type", "open_text")
    ex_value  = 8 if ex_type == "nps" else (4 if ex_type in ("csat", "rating") else "example answer")
    has_nps      = any(q.get("type") == "nps" for q in inp.questions)
    ex_nps_json  = "8" if has_nps else "null"

    return f"""\
You are a survey response simulation expert. Generate {batch_n} realistic, distinct synthetic responses for the survey below.

SURVEY: "{inp.survey_title}"
{intent_line}

PERSONA MIX (for these {batch_n} responses, starting at respondent #{offset + 1}):
{persona_guide}

QUESTIONS:
{questions_str}

{_ANSWER_RULES}

RULES:
1. Every non-statement question MUST have an answer (do not skip).
2. Open-text answers must sound like a real person — use natural language, first person.
3. Match open-text sentiment to the NPS/rating score of that response.
4. Persona description should be ≤10 words (e.g. "Long-time user, frustrated with onboarding").
5. Each response must be unique — different concerns, phrasing, scores.
6. For multiple_choice / dropdown / ranking / checkbox: use ONLY strings from the provided OPTIONS list, verbatim.
7. CRITICAL: Use the EXACT questionId values shown in the QUESTIONS list above — do NOT invent ids like "q1", "q2".

Return ONLY valid JSON — no markdown, no explanation:
{{"responses": [{{"persona": "...", "nps_score": {ex_nps_json}, "answers": [{{"questionId": "{ex_qid}", "type": "{ex_type}", "value": {json.dumps(ex_value)}}}, ...]}}]}}
"""


# ── LLM call + batch loop ─────────────────────────────────────────────────────


# Responses per LLM call. Fixed 2026-07-06: was 5, which for surveys with many
# questions or verbose types (ranking/matrix/checkbox produce arrays/objects,
# not a single scalar) could push the JSON output past response_gen's
# max_tokens budget, truncating mid-string ("EOF while parsing a string") —
# call_agent's retry loop resends the same prompt at the same token budget, so
# a truncation caused by output size doesn't self-heal by retrying; it just
# fails the same way up to 3 times and the batch silently generates 0
# responses. Lowered to 3 to leave real headroom; max_tokens for response_gen
# was also raised in lib/models.py as defense in depth.
_BATCH_SIZE = 3   # responses per LLM call — keeps output tokens manageable


def _strip_think(raw: str) -> str:
    cleaned = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```\s*$", "", cleaned, flags=re.DOTALL)
    return cleaned.strip()


async def _generate_batch(inp: ResponseGenInput, batch_n: int, offset: int) -> list[GeneratedResponse]:
    """Call the LLM for one batch, validate, return list of responses (may be empty on failure)."""
    batch_num   = offset // _BATCH_SIZE + 1
    total_batches = (inp.count + _BATCH_SIZE - 1) // _BATCH_SIZE

    logger.info(
        "response_gen_batch_start",
        survey_id=inp.survey_id,
        batch=f"{batch_num}/{total_batches}",
        batch_n=batch_n,
        offset=offset,
    )

    system = _build_system(inp, batch_n, offset)
    user   = f"Generate exactly {batch_n} responses now."

    try:
        output, _ = await call_agent(
            agent_name="response_gen",
            system=system,
            user=user,
            output_schema=ResponseGenBatch,
        )
        logger.info(
            "response_gen_batch_ok",
            survey_id=inp.survey_id,
            batch=f"{batch_num}/{total_batches}",
            batch_n=batch_n,
            offset=offset,
            got=len(output.responses),
        )
        return output.responses

    except Exception as exc:
        logger.warning(
            "response_gen_batch_failed",
            survey_id=inp.survey_id,
            batch=f"{batch_num}/{total_batches}",
            offset=offset,
            error=str(exc)[:200],
        )
        return []


async def generate_responses(inp: ResponseGenInput) -> list[dict]:
    """Generate `inp.count` synthetic responses — all batches run in parallel.

    Parallel execution reduces wall-clock time from N_batches × batch_time
    to ~1 × batch_time regardless of how many batches are needed.
    """
    import asyncio as _asyncio

    # Build all batch specs up front
    batches = []
    remaining = inp.count
    while remaining > 0:
        batch_n = min(remaining, _BATCH_SIZE)
        offset  = inp.count - remaining
        batches.append((batch_n, offset))
        remaining -= batch_n

    # Run all batches concurrently
    batch_results = await _asyncio.gather(
        *[_generate_batch(inp, batch_n, offset) for batch_n, offset in batches],
        return_exceptions=True,
    )

    all_responses: list[GeneratedResponse] = []
    for res in batch_results:
        if isinstance(res, list):
            all_responses.extend(res)
        # exceptions are already caught inside _generate_batch → returns []

    result: list[dict] = []
    for resp in all_responses:
        answers = [a.model_dump() for a in resp.answers]
        result.append({
            "answers":   answers,
            "nps_score": resp.nps_score,
            "persona":   resp.persona,
        })

    logger.info(
        "response_gen_complete",
        survey_id=inp.survey_id,
        requested=inp.count,
        generated=len(result),
    )
    return result


# ── Thin agent wrapper ────────────────────────────────────────────────────────

class ResponseGeneratorAgent:
    async def run(self, inp: ResponseGenInput) -> tuple[list[dict], list[dict]]:
        responses = await generate_responses(inp)
        return responses, []


response_generator_agent = ResponseGeneratorAgent()
