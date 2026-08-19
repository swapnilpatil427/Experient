"""Adapter between the survey skills (survey-creator, copilot-analyst) and the
frontend Question schema.

The survey skills emit a deliberately simplified question shape in their
SKILL.md output contract:

    {"id", "type", "text", "options", "scale": {min, max, min_label, max_label},
     "required", "skip_logic_hint"}

The frontend (and every legacy agent) uses the richer ``schemas.question.Question``
shape (``question`` not ``text``, ``scaleMax``/``labelLow``/``labelHigh`` instead
of a nested ``scale`` object, a wider type enum).

This module converts between the two so the survey-creator / copilot-analyst
skills can be wired into the creation + editing endpoints while reusing the
existing post-LLM validation, bias checks, and revision loop. Any unmappable
input raises ``ValueError`` so the caller treats it as a skill failure and falls
back to the legacy agent.
"""
from __future__ import annotations

from crystalos.schemas.question import Question

# Skill question type → frontend QuestionType, with default scaleMax for scale types.
_TYPE_MAP: dict[str, tuple[str, int | None]] = {
    "nps":             ("nps", 10),
    "csat":            ("csat", 5),
    "ces":             ("rating", 7),
    "scale":           ("rating", 5),
    "rating":          ("rating", 5),
    "slider":          ("slider", None),
    "multiple_choice": ("multiple_choice", None),
    "checkbox":        ("checkbox", None),
    "dropdown":        ("dropdown", None),
    "open_text":       ("open_text", None),
    "short_text":      ("short_text", None),
    "boolean":         ("multiple_choice", None),   # rendered as Yes/No choice
    "statement":       ("statement", None),
    "date":            ("date", None),
}


def skill_question_to_model(sq: dict) -> Question:
    """Convert one skill-shaped question dict into a validated ``Question``.

    Raises ValueError if the input is not a dict or lacks question text.
    """
    if not isinstance(sq, dict):
        raise ValueError("skill question is not an object")

    raw_type = str(sq.get("type", "open_text")).lower().strip()
    mapped_type, default_scale_max = _TYPE_MAP.get(raw_type, ("open_text", None))

    text = sq.get("text") or sq.get("question") or ""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("skill question has no text")

    model: dict = {
        "id":       str(sq.get("id") or "").strip() or "q1",
        "type":     mapped_type,
        "question": text.strip(),
        "required": bool(sq.get("required", False)),
    }

    # Options — for boolean, synthesise Yes/No when none provided.
    options = sq.get("options")
    if isinstance(options, list) and options:
        model["options"] = [str(o) for o in options]
    elif raw_type == "boolean":
        model["options"] = ["Yes", "No"]

    # Scale → scaleMax / labelLow / labelHigh
    scale = sq.get("scale")
    if isinstance(scale, dict):
        scale_max = scale.get("max")
        if isinstance(scale_max, (int, float)):
            model["scaleMax"] = int(scale_max)
        if scale.get("min_label"):
            model["labelLow"] = str(scale["min_label"])
        if scale.get("max_label"):
            model["labelHigh"] = str(scale["max_label"])
    if "scaleMax" not in model and default_scale_max is not None:
        model["scaleMax"] = default_scale_max

    return Question.model_validate(model)


def skill_questions_to_models(skill_questions: list) -> list[Question]:
    """Convert a list of skill-shaped questions into validated ``Question`` objects.

    Raises ValueError if the list is empty; raises on the first question that
    fails to map (fail-fast, not best-effort-per-question — see
    skill_question_to_model).
    """
    if not isinstance(skill_questions, list) or not skill_questions:
        raise ValueError("skill output has no questions")

    return [skill_question_to_model(sq) for sq in skill_questions]


def question_models_to_skill_shape(questions: list[Question]) -> list[dict]:
    """Convert frontend ``Question`` objects into the simplified skill input shape.

    Used to feed the current survey into the copilot-analyst skill.
    """
    shaped: list[dict] = []
    for q in questions:
        scale = None
        if q.scaleMax is not None or q.labelLow or q.labelHigh:
            scale = {
                "min": q.min if q.min is not None else 0,
                "max": q.scaleMax if q.scaleMax is not None else q.max,
                "min_label": q.labelLow,
                "max_label": q.labelHigh,
            }
        shaped.append({
            "id":       q.id,
            "type":     q.type,
            "text":     q.question,
            "options":  q.options,
            "scale":    scale,
            "required": q.required,
        })
    return shaped
