"""Sentiment utilities — LLM-assisted ABSA on open-text answers."""
from __future__ import annotations
from typing import Any
import asyncio
import json
import traceback
import re
import structlog

logger = structlog.get_logger()

# Aligned across LLM prompt, heuristic fallback, and DB writes.
EMOTION_LABELS = [
    "joy", "satisfaction", "frustration", "disappointment",
    "anger", "confusion", "surprise", "trust", "sadness", "neutral",
]

_EMOTION_LIST_STR = ", ".join(f'"{e}"' for e in EMOTION_LABELS)
_EMOTION_SET      = set(EMOTION_LABELS)
_VALID_SENTIMENTS = {"positive", "negative", "neutral"}

# ── Few-shot examples baked into the prompt ───────────────────────────────────
_FEW_SHOT = (
    'EXAMPLES (do not include in output):\n'
    'Q: "How satisfied were you with our support?"  Response: "The agent kept me on hold for 40 minutes and never resolved my issue."\n'
    '→ {"i":1,"aspect":"support wait time","sentiment":"negative","score":-0.85,"emotion":"frustration"}\n\n'
    'Q: "What did you like most?"  Response: "Everything worked seamlessly — setup was effortless and the UI is beautiful."\n'
    '→ {"i":2,"aspect":"ease of use","sentiment":"positive","score":0.92,"emotion":"satisfaction"}\n\n'
    'Q: "Any suggestions?"  Response: "The documentation could be more detailed for advanced features."\n'
    '→ {"i":3,"aspect":"documentation","sentiment":"neutral","score":-0.15,"emotion":"confusion"}\n\n'
    'Q: "Rate your overall experience"  Response: "Customer satisfaction: extremely satisfied (5/5)"\n'
    '→ {"i":4,"aspect":"overall experience","sentiment":"positive","score":0.90,"emotion":"joy"}\n\n'
)


def _score_to_sentiment(score: float) -> str:
    """Derive a consistent sentiment label from a numeric score."""
    if score >= 0.25:
        return "positive"
    if score <= -0.25:
        return "negative"
    return "neutral"


def detect_dominant_emotion(text: str) -> str:
    """Heuristic keyword-based emotion detection — fallback only.
    All returned values are guaranteed to be in EMOTION_LABELS."""
    text_lower = text.lower()
    patterns = {
        "frustration":    ["frustrat", "annoy", "irritat", "stuck", "loop", "again", "still", "keeps", "waste"],
        "anger":          ["angry", "furious", "rage", "unacceptable", "terrible", "worst", "horrible", "awful"],
        "disappointment": ["disappoint", "let down", "expected more", "not what i", "fall short"],
        "sadness":        ["sad", "unfortunate", "unhappy", "wish it", "miss"],
        "joy":            ["great", "excellent", "amazing", "love", "fantastic", "perfect", "wonderful"],
        "satisfaction":   ["satisfied", "happy with", "pleased", "good job", "well done", "smooth", "easy"],
        "confusion":      ["confus", "unclear", "don't understand", "not sure", "hard to find", "complicated"],
        "surprise":       ["surprise", "unexpect", "wow", "didn't expect", "impressive"],
        "trust":          ["reliable", "trustworthy", "dependable", "consistent", "always works"],
    }
    for emotion, keywords in patterns.items():
        if any(kw in text_lower for kw in keywords):
            return emotion  # all keys are in EMOTION_LABELS
    return "neutral"


def score_sentiment(text: str) -> float:
    """Heuristic sentiment score -1.0 to 1.0."""
    positive = ["good", "great", "excellent", "amazing", "love", "perfect", "fast", "easy",
                "helpful", "smooth", "happy", "satisfied", "pleased", "wonderful", "fantastic"]
    negative = ["bad", "terrible", "poor", "slow", "difficult", "broken", "frustrat", "error",
                "fail", "awful", "disappoint", "annoying", "confusing", "complicated", "waste"]
    t = text.lower()
    pos = sum(1 for w in positive if w in t)
    neg = sum(1 for w in negative if w in t)
    total = pos + neg
    if total == 0:
        return 0.0
    return round((pos - neg) / total, 2)


def _build_absa_prompt(batch: list[dict], survey_context: str = "") -> str:
    """Build the ABSA prompt — includes question context, few-shot examples,
    and requires an explicit 'i' key for index-safe response matching."""
    lines = []
    for j, t in enumerate(batch):
        q = (t.get("question") or "").strip()
        text = t["text"][:300]
        if q:
            lines.append(f'{j + 1}. [Q: "{q[:120]}"]\n   Response: {text}')
        else:
            lines.append(f"{j + 1}. {text}")
    numbered = "\n".join(lines)

    ctx_line = f'Survey: "{survey_context}"\n\n' if survey_context else ""

    return (
        f"You are an expert CX analyst specializing in survey response classification.\n"
        f"{ctx_line}"
        f"{_FEW_SHOT}"
        f"Now analyze the following survey responses. For EACH return:\n"
        f"- i: the response number (integer, 1-indexed — REQUIRED)\n"
        f"- aspect: the main topic being commented on (2-5 words, lowercase)\n"
        f"- sentiment: exactly one of: positive, negative, neutral\n"
        f"- score: float -1.0 (very negative) to 1.0 (very positive). Use the FULL range:\n"
        f"  • 5/5 satisfaction or glowing praise → 0.85 to 1.0\n"
        f"  • 1/5 or angry complaint → -0.85 to -1.0\n"
        f"  • Mild issue or suggestion → -0.1 to -0.4\n"
        f"  • Balanced / mixed feedback → -0.1 to 0.1\n"
        f"- emotion: exactly one of: {_EMOTION_LIST_STR}\n\n"
        f"Rules:\n"
        f"1. sentiment and score MUST agree: positive→score>0.2, negative→score<-0.2.\n"
        f"2. Do NOT default to neutral — every response has a detectable tone.\n"
        f"3. emotion must reflect emotional tone, NOT the topic being discussed.\n"
        f"4. i must match the response number exactly.\n\n"
        f"Responses to analyze:\n{numbered}\n\n"
        f"Return ONLY a valid JSON array with exactly {len(batch)} objects, no explanation:\n"
        f'[{{"i":1,"aspect":"...","sentiment":"...","score":0.0,"emotion":"..."}}, ...]\n'
    )


def _repair_truncated_json_array(text: str) -> str:
    """Attempt to salvage a truncated JSON array by discarding the last incomplete item.

    When the LLM hits its token limit mid-response, the JSON array is cut off
    partway through the last object. Strategy:
      1. Find the last complete JSON object (ends with '}')
      2. Close the array after it
    Returns the repaired string, or the original if repair fails.
    """
    # Find the last '}'  before truncation
    last_brace = text.rfind("}")
    if last_brace == -1:
        return text
    candidate = text[: last_brace + 1].rstrip()
    # Make sure it closes as a valid array
    if not candidate.endswith("]"):
        candidate = candidate + "]"
    # If it starts with '[', we're good; otherwise wrap it
    candidate = candidate.strip()
    if not candidate.startswith("["):
        candidate = "[" + candidate
    return candidate


# One flat ABSA object per response (i, aspect, sentiment, score, emotion —
# all scalars, never nested) — a non-greedy, no-nested-brace match is exactly
# this batch's actual shape, so this only ever mis-splits an object whose OWN
# string field contains a literal '{' or '}' (e.g. a verbatim quoting "the
# {submit} button") — a bounded, rare mis-split, not a source of false matches.
_OBJECT_RE = re.compile(r"\{[^{}]*\}")


def _extract_valid_absa_objects(text: str) -> list[dict]:
    """Last-resort recovery when the array-level parse fails even after the
    truncation repair above: a SINGLE malformed object anywhere in the batch
    (not just the last one) — e.g. the LLM emitted an unescaped quote or a raw
    newline inside a string field — corrupts `json.loads` for the WHOLE array,
    even though every OTHER object in the response is perfectly well-formed.

    Scans for individual ``{...}`` substrings and parses each independently,
    silently discarding any that don't parse — the caller (`_parse_absa_batch`)
    already degrades a missing/invalid item to `_heuristic_item` via its
    `i_lookup` fallback, so losing ONE corrupted object here still preserves
    every other object's real LLM sentiment/emotion, instead of the entire
    batch falling back to the weaker keyword heuristic just because one
    response's text happened to break the JSON.

    Returns whatever objects parse — an empty list if NONE do, in which case
    the caller re-raises the original error instead of treating this as
    success (see `_parse_absa_batch`): a genuinely unusable response should
    still surface as a real failure (logged, heuristic-batch fallback via
    `run_absa_llm`'s own except-block), not silently look identical to "the
    LLM legitimately returned zero items."
    """
    results = []
    for match in _OBJECT_RE.finditer(text):
        try:
            obj = json.loads(match.group(0), strict=False)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            results.append(obj)
    return results


def _parse_absa_batch(raw: str, batch: list[dict]) -> list[dict]:
    """Parse LLM response. Uses 'i'-key lookup for positional safety; falls back to order."""
    cleaned = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```\s*$", "", cleaned, flags=re.DOTALL).strip()

    try:
        # strict=False (fixed 2026-07-07): permits raw control characters
        # (e.g. a literal newline) inside a string value — the LLM
        # occasionally emits one instead of the escaped `\n` JSON requires,
        # which under strict parsing raises "Invalid control character", not
        # the "Unterminated string" case handled below, but the same
        # single-item corruption risk applies, so it's handled at the same
        # layer.
        parsed = json.loads(cleaned, strict=False)
    except json.JSONDecodeError as exc:
        try:
            # Attempt to recover a truncated JSON array before giving up —
            # the LLM hit its token limit mid-response.
            repaired = _repair_truncated_json_array(cleaned)
            parsed = json.loads(repaired, strict=False)
        except json.JSONDecodeError:
            # Fixed 2026-07-07 (production incident: "Unterminated string
            # starting at: line 6 column 5"): a single malformed object
            # ANYWHERE in the batch — not just a truncated tail — e.g. one
            # response's own text contained an unescaped quote or a raw
            # newline that broke that ONE object's string, corrupts
            # json.loads for the entire array even though every other
            # object is perfectly well-formed. Recovers whichever
            # individual objects DO parse instead of discarding the whole
            # batch's real LLM sentiment for one bad item.
            parsed = _extract_valid_absa_objects(cleaned)
            if not parsed:
                # Nothing at all was recoverable — re-raise the ORIGINAL
                # error rather than silently proceeding with an empty
                # array. _process_batch's caller (run_absa_llm) still logs
                # "absa_batch_failed" with the real traceback and falls
                # back to the full heuristic batch, exactly as it did
                # before this fix — that observability signal (a
                # genuinely-unusable LLM response, not just one bad item)
                # must not go silent.
                raise exc
    if isinstance(parsed, dict):
        for v in parsed.values():
            if isinstance(v, list):
                logger.warning("absa_unwrapped_dict", keys=list(parsed.keys())[:5])
                parsed = v
                break
        else:
            raise ValueError(f"Expected JSON array, got dict with keys: {list(parsed.keys())[:5]}")
    if not isinstance(parsed, list):
        raise ValueError(f"Expected JSON array, got {type(parsed).__name__}")

    # Build i→item lookup (prompt uses 1-based "i" key)
    i_lookup: dict[int, dict] = {}
    for item in parsed:
        if isinstance(item, dict):
            i_val = item.get("i")
            if isinstance(i_val, (int, float)):
                key = int(i_val)
                if 1 <= key <= len(batch):
                    i_lookup[key] = item

    # Use i_lookup if most items have valid "i" keys; otherwise fall back to positional
    use_i = len(i_lookup) >= max(1, len(parsed) * 0.7)

    results = []
    for j, t in enumerate(batch):
        item = i_lookup.get(j + 1) if use_i else (parsed[j] if j < len(parsed) else None)
        if not isinstance(item, dict):
            results.append(_heuristic_item(t))
            continue

        raw_score     = float(item.get("score", 0.0))
        raw_sentiment = (item.get("sentiment") or "").strip().lower()
        raw_emotion   = (item.get("emotion")   or "").strip().lower()

        # Validate and enforce score/sentiment consistency
        sentiment = raw_sentiment if raw_sentiment in _VALID_SENTIMENTS else _score_to_sentiment(raw_score)
        if sentiment == "positive" and raw_score < 0:
            raw_score = abs(raw_score)
        elif sentiment == "negative" and raw_score > 0:
            raw_score = -abs(raw_score)

        # Validate emotion — fall back to heuristic if LLM returned something off-list
        emotion = raw_emotion if raw_emotion in _EMOTION_SET else detect_dominant_emotion(t["text"])

        results.append({
            "response_id": t["response_id"],
            "question_id": t["question_id"],
            "text":        t["text"],
            "aspect":      (item.get("aspect") or "general").strip().lower(),
            "sentiment":   sentiment,
            "score":       round(raw_score, 2),
            "emotion":     emotion,
        })
    return results


def _heuristic_item(t: dict) -> dict:
    """Heuristic fallback — score determines label; never hardcodes neutral."""
    score = score_sentiment(t["text"])
    return {
        "response_id": t["response_id"],
        "question_id": t["question_id"],
        "text":        t["text"],
        "aspect":      "general",
        "sentiment":   _score_to_sentiment(score),
        "score":       score,
        "emotion":     detect_dominant_emotion(t["text"]),
    }


def _heuristic_batch(batch: list[dict]) -> list[dict]:
    return [_heuristic_item(t) for t in batch]


async def run_absa_llm(
    texts: list[dict],
    llm_func,
    batch_size: int = 10,
    semaphore: asyncio.Semaphore | None = None,
    survey_context: str = "",
) -> list[dict]:
    """
    Run Aspect-Based Sentiment Analysis via LLM in parallel batches.

    texts: [{response_id, text, question_id, question?}]
    llm_func: async callable (prompt: str) -> str
    batch_size: number of texts per LLM call
    semaphore: optional asyncio.Semaphore to cap concurrency (default: Semaphore(3))
    survey_context: optional survey title + intent for prompt grounding

    Returns: list of per-text result dicts in the same order as input texts.
    """
    if not texts:
        return []

    sem = semaphore if semaphore is not None else asyncio.Semaphore(3)

    batches: list[list[dict]] = [
        texts[i:i + batch_size] for i in range(0, len(texts), batch_size)
    ]

    async def _process_batch(batch: list[dict]) -> list[dict]:
        async with sem:
            prompt = _build_absa_prompt(batch, survey_context=survey_context)
            try:
                raw = await llm_func(prompt)
                return _parse_absa_batch(raw, batch)
            except Exception as exc:
                logger.error("absa_batch_failed", error=str(exc), traceback=traceback.format_exc())
                return _heuristic_batch(batch)

    batch_tasks = [_process_batch(batch) for batch in batches]
    batch_results = await asyncio.gather(*batch_tasks, return_exceptions=True)

    results: list[dict] = []
    for i, batch_result in enumerate(batch_results):
        if isinstance(batch_result, Exception):
            logger.error("absa_batch_gather_exception", batch_index=i, error=str(batch_result))
            results.extend(_heuristic_batch(batches[i]))
        else:
            results.extend(batch_result)

    return results
