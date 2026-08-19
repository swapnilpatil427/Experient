"""Agents Skill Runtime — loads and executes a single skill end-to-end.

Responsibilities:
  - Load SKILL.md body + reference files
  - Inject top-3 few-shot examples from skill_examples DB table
  - Call LLM via call_agent() using appropriate model config
  - Parse and validate JSON output
  - Run EVALS.md quality checks (hybrid: structural rules + LLM judge)
  - Retry once on eval failure with failure context injected
  - Write passing examples to skill_examples table (async, non-blocking)
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from pydantic import BaseModel, ConfigDict

from crystalos.lib.json_coerce import json_dumps_safe
from crystalos.lib.logger import logger
from crystalos.lib.openrouter import _call_with_backoff
from crystalos.lib.pii_scrubber import scrub_dict as _scrub_dict
from crystalos.lib.skill_validators import SKILL_CRITERION_VALIDATORS


class _SkillOutput(BaseModel):
    """Open-ended output model — accepts any JSON fields returned by the LLM."""
    model_config = ConfigDict(extra="allow")

    def to_dict(self) -> dict:
        return self.model_dump()


@dataclass
class SkillResult:
    output: dict
    eval_score: float
    eval_passed: bool
    eval_issues: list[str]
    retried: bool
    skill_name: str
    skill_version: str
    model: str
    tokens_used: int
    latency_ms: float
    reasoning_trace: dict = field(default_factory=dict)


STRUCTURAL_KEYWORDS: frozenset[str] = frozenset({
    "valid json", "required fields", "word count", "character limit",
    "count", "length", "number of", "contains", "starts with", "ends with",
    # Bare "present" is deliberately absent: criteria like crystal-support E5
    # ("present when resolved=false and absent when resolved=true") are conditional
    # logic, not presence checks, and must stay with the LLM judge.
    "non-empty",
})


def _is_structural_criterion(description: str) -> bool:
    """Return True if this criterion can be evaluated deterministically."""
    desc = description.lower()
    return any(kw in desc for kw in STRUCTURAL_KEYWORDS)


def _named_output_fields(description: str, output: dict) -> list[str]:
    """Return the output keys a criterion explicitly names, in output order.

    A presence criterion normally lists the fields it cares about, e.g.
    "answer, citations, suggestions present and non-empty" or
    "Required fields present and non-empty: title, executive_summary, ...".
    Intersecting the description's word tokens with the output's real keys is
    deliberately conservative: an unrecognised phrasing yields `[]`, and the
    caller then falls back to scoring every key (the historical behaviour).

    Returns [] when the criterion names no output field.
    """
    tokens = set(re.findall(r"[a-z_][a-z0-9_]*", description.lower()))
    return [k for k in output.keys() if k.lower() in tokens]


# ── Deterministic pattern checks (Phase 2 broadened structural matching) ──────
#
# These are matched BEFORE the STRUCTURAL_KEYWORDS dispatch, on their own regexes,
# so a criterion only gets the deterministic answer when the exact shape matches.
# If the regex doesn't match, the criterion falls through unchanged to whatever
# it would have done before (existing keyword-gated structural check, or the LLM
# judge) — see `_eval_criterion`.

_ENTRIES_PATTERN = re.compile(
    r"(\w+)\s+has\s+(\d+)-(\d+)\s+entries?\s+with\s+([\w,\s]+)", re.IGNORECASE
)

_ENUM_PATTERN = re.compile(
    # The colon is required (not optional): every real "is one of" criterion in
    # the skill corpus is phrased "<field> is one of: a, b, c" — requiring the
    # colon keeps this from accidentally matching ordinary prose like "the
    # rating is one of the best we've seen".
    r"(\w+)\s+is\s+one\s+of:\s*([\w,\s]+)", re.IGNORECASE
)


def _eval_entries_with_fields(match: re.Match, output: dict) -> float:
    """"<field> has <lo>-<hi> entries with <k1, k2, ...>" — e.g. csat-action-advisor
    E2: "actions has 1-4 entries with id, type, priority, title, description, params".

    Checks: the named field is a list, its length is within [lo, hi] inclusive,
    and every entry is a dict with all required keys present (non-empty), using
    the same "present" convention as the existing "required fields" check.
    """
    field_name = match.group(1)
    lo, hi = int(match.group(2)), int(match.group(3))
    required_keys = [k.strip() for k in match.group(4).split(",") if k.strip()]

    values = output.get(field_name)
    if not isinstance(values, list):
        return 0.0
    if not (lo <= len(values) <= hi):
        return 0.0
    for entry in values:
        if not isinstance(entry, dict):
            return 0.0
        for key in required_keys:
            if entry.get(key) in (None, "", [], {}):
                return 0.0
    return 1.0


def _eval_enum_membership(match: re.Match, output: dict) -> float:
    """"<field> is one of: a, b, c" — e.g. specialist-csat E3:
    "csat_rating is one of: excellent, good, needs_improvement, critical".

    Checks output[field] is a member of the literal comma-separated value set.
    """
    field_name = match.group(1)
    allowed = {v.strip().rstrip(".") for v in match.group(2).split(",") if v.strip()}
    value = output.get(field_name)
    return 1.0 if value in allowed else 0.0


# ── Kind A extension point: output transforms (Phase 3 — PII wiring) ──────────
#
# A small ordered list of `dict -> dict` transforms run over a skill's resolved
# output after eval-checking finishes and before the example-bank write, so
# scrubbed output (not raw) is what gets persisted/logged downstream. Each
# transform is fail-open: a raising transform is caught, logged, and its effect
# is skipped — it never corrupts the output or propagates.

_OUTPUT_TRANSFORMS: list[Callable[[dict], dict]] = []


def register_output_transform(fn: Callable[[dict], dict]) -> Callable[[dict], dict]:
    """Decorator/registrar: append `fn` to the ordered list of output transforms."""
    _OUTPUT_TRANSFORMS.append(fn)
    return fn


# PII scrubbing must run on every skill's output before it reaches the example
# bank or any downstream consumer of SkillResult.output.
_OUTPUT_TRANSFORMS.append(_scrub_dict)


class SkillRuntime:
    """Stateless executor for a skill given its metadata dict from SkillRegistry."""

    async def execute(
        self,
        skill_name: str,
        skill_meta: dict,
        input_data: dict,
        ctx: dict,
        write_example: bool = True,
    ) -> SkillResult:
        from crystalos.lib.constants import SKILL_EVAL_PASS_THRESHOLD, SKILL_EXAMPLE_WRITE_THRESHOLD
        from crystalos.lib.models import get_skill_model
        from crystalos.lib.openrouter import call_agent

        t0 = time.monotonic()

        # Model resolution: use skill-specific model config
        model_cfg = get_skill_model(skill_name)

        skill_version = skill_meta.get("version", "1.0.0")
        timeout = skill_meta.get("timeout_seconds", 60)
        max_output_tokens = min(
            skill_meta.get("max_output_tokens", model_cfg.max_tokens),
            model_cfg.max_tokens,
        )
        model_cfg = dataclasses.replace(model_cfg, max_tokens=max_output_tokens)
        max_retries = skill_meta.get("max_retries", 1)

        # Build system prompt (SKILL.md body + references + examples)
        system = await self._build_system(skill_meta, input_data)
        user_msg = json_dumps_safe(input_data, indent=2)

        output_raw: dict = {}
        model_used: str = model_cfg.model
        tokens_used = 0

        # ── First attempt ──────────────────────────────────────────────────
        try:
            result, credit = await asyncio.wait_for(
                call_agent(
                    agent_name=skill_name,
                    system=system,
                    user=user_msg,
                    output_schema=_SkillOutput,
                    current_tokens=ctx.get("current_tokens", 0),
                    model_config=model_cfg,
                ),
                timeout=float(timeout),
            )
            output_raw = result.to_dict() if hasattr(result, "to_dict") else {}
            if hasattr(credit, "model"):
                model_used = credit.model
                tokens_used = credit.input_tokens + credit.output_tokens
            elif isinstance(credit, dict):
                model_used = credit.get("model", model_used)
                tokens_used = credit.get("input_tokens", 0) + credit.get("output_tokens", 0)
        except asyncio.TimeoutError:
            logger.warning("skill_timeout", skill=skill_name, timeout_seconds=timeout)
            return SkillResult(
                output={"error": f"Timed out after {timeout}s"},
                eval_score=0.0,
                eval_passed=False,
                eval_issues=[f"Timeout after {timeout}s"],
                retried=False,
                skill_name=skill_name,
                skill_version=skill_version,
                model=model_used,
                tokens_used=0,
                latency_ms=(time.monotonic() - t0) * 1000,
            )
        except Exception as exc:
            logger.error("skill_execution_error", skill=skill_name, error=str(exc))
            return SkillResult(
                output={"error": str(exc)},
                eval_score=0.0,
                eval_passed=False,
                eval_issues=[str(exc)[:120]],
                retried=False,
                skill_name=skill_name,
                skill_version=skill_version,
                model=model_used,
                tokens_used=tokens_used,
                latency_ms=(time.monotonic() - t0) * 1000,
            )

        # ── Eval check ─────────────────────────────────────────────────────
        eval_score, eval_passed, eval_issues = await self._check_evals(skill_meta, input_data, output_raw)
        retried = False

        # ── Retry on failure ───────────────────────────────────────────────
        if not eval_passed and max_retries > 0:
            retried = True
            retry_ctx = {
                "retry_reason": "eval_failure",
                "failed_criteria": eval_issues,
                "eval_score": round(eval_score, 3),
                "previous_output": output_raw,
                "instruction": (
                    "Your previous response did not meet quality criteria. "
                    "The issues are listed in failed_criteria. Fix them and respond again."
                ),
            }
            retry_user = json_dumps_safe({"input": input_data, "retry_context": retry_ctx}, indent=2)
            try:
                result2, credit2 = await asyncio.wait_for(
                    call_agent(
                        agent_name=skill_name,
                        system=system,
                        user=retry_user,
                        output_schema=_SkillOutput,
                        current_tokens=tokens_used,
                        model_config=model_cfg,
                    ),
                    timeout=float(timeout),
                )
                output_raw = result2.to_dict() if hasattr(result2, "to_dict") else output_raw
                if hasattr(credit2, "input_tokens"):
                    tokens_used += credit2.input_tokens + credit2.output_tokens
                eval_score, eval_passed, eval_issues = await self._check_evals(
                    skill_meta, input_data, output_raw
                )
            except Exception as exc:
                logger.warning("skill_retry_failed", skill=skill_name, error=str(exc))

        latency_ms = (time.monotonic() - t0) * 1000

        # ── Output transforms (PII scrub, etc.) ────────────────────────────
        # Run after eval_score/eval_passed/output_raw are fully settled and
        # before the example-bank write, so scrubbed output — never raw — is
        # what gets persisted and returned.
        for transform in _OUTPUT_TRANSFORMS:
            try:
                output_raw = transform(output_raw)
            except Exception as exc:
                logger.warning(
                    "output_transform_failed",
                    skill=skill_name,
                    transform=getattr(transform, "__name__", repr(transform)),
                    error=str(exc),
                )

        # ── Write example if quality passes ───────────────────────────────
        if write_example and eval_score >= SKILL_EXAMPLE_WRITE_THRESHOLD:
            asyncio.create_task(
                self._write_example_async(
                    skill_name=skill_name,
                    skill_version=skill_version,
                    eval_score=eval_score,
                    input_data=input_data,
                    output=output_raw,
                    ctx=ctx,
                )
            )

        logger.info(
            "skill_executed",
            skill=skill_name,
            version=skill_version,
            eval_score=round(eval_score, 3),
            eval_passed=eval_passed,
            retried=retried,
            latency_ms=round(latency_ms),
            tokens=tokens_used,
        )

        # Langfuse generation — shows each skill call in the pipeline trace
        try:
            from crystalos.lib.tracer import get_tracer as _get_tracer
            _get_tracer().log_generation(
                name=f"skill:{skill_name}",
                model=model_used,
                input={"skill": skill_name, "version": skill_version},
                output={
                    "eval_score":  round(eval_score, 3),
                    "eval_passed": eval_passed,
                    "retried":     retried,
                    "output_keys": list(output_raw.keys()) if output_raw else [],
                },
                usage={"input": 0, "output": tokens_used, "unit": "TOKENS"},
            )
        except Exception:
            pass

        return SkillResult(
            output=output_raw,
            eval_score=eval_score,
            eval_passed=eval_passed,
            eval_issues=eval_issues,
            retried=retried,
            skill_name=skill_name,
            skill_version=skill_version,
            model=model_used,
            tokens_used=tokens_used,
            latency_ms=latency_ms,
            reasoning_trace={
                "eval_score": eval_score,
                "eval_issues": eval_issues,
                "model": model_used,
                "retried": retried,
                "schema_version": 1,
            },
        )

    # ── System prompt assembly ─────────────────────────────────────────────

    async def _build_system(self, skill_meta: dict, input_data: dict) -> str:
        """Assemble system prompt: SKILL.md body + reference files + few-shot examples."""
        parts: list[str] = [skill_meta.get("_body", "")]

        # Reference files in skill's references/ subdirectory. Disk reads are
        # blocking — run off the event loop so they can't stall other
        # concurrent SSE streams sharing this process.
        ref_block = await asyncio.to_thread(self._read_reference_files, skill_meta)
        if ref_block:
            parts.append(ref_block)

        # Few-shot examples: DB-sourced production examples take priority; if a
        # skill has none yet (e.g. it's new, or hasn't accumulated production
        # traffic), fall back to hand-authored worked examples in its own
        # EXAMPLES.md file. Never both — DB examples are proven-in-production
        # and always preferred once they exist.
        examples = await self._fetch_examples(skill_meta["name"])
        if not examples:
            examples = await asyncio.to_thread(self._parse_examples_md_fallback, skill_meta)
        if examples:
            ex_block = "\n\n---\n## High-Quality Examples from Production\n\n"
            for i, ex in enumerate(examples[:3], 1):
                score = ex.get("eval_score")
                label = f"quality score: {score:.2f}" if score is not None else "seed example"
                ex_block += (
                    f"### Example {i} ({label})\n"
                    f"**Input:**\n```json\n{json_dumps_safe(ex['input_json'], indent=2)}\n```\n"
                    f"**Output:**\n```json\n{json_dumps_safe(ex['output_json'], indent=2)}\n```\n\n"
                )
            parts.append(ex_block)

        return "\n".join(parts)

    def _read_reference_files(self, skill_meta: dict) -> str:
        """Read a skill's references/*.md files into one appendable block.
        Synchronous/blocking — callers should run this via asyncio.to_thread."""
        skill_dir = Path(skill_meta.get("_dir", "."))
        refs_dir = skill_dir / "references"
        if not refs_dir.is_dir():
            return ""
        ref_sections: list[str] = []
        for ref_file in sorted(refs_dir.glob("*.md")):
            try:
                content = ref_file.read_text(encoding="utf-8")
                ref_sections.append(f"\n## Reference: {ref_file.stem}\n\n{content}")
            except Exception:
                pass
        if not ref_sections:
            return ""
        return "\n\n---\n" + "\n".join(ref_sections)

    _EXAMPLE_BLOCK_RE = re.compile(r"\*\*([^*]+)\*\*\s*:?\s*```json\s*(.*?)```", re.DOTALL)

    def _parse_examples_md_fallback(self, skill_meta: dict) -> list[dict]:
        """Parse worked examples directly out of a skill's own EXAMPLES.md as a
        fallback source of few-shot examples when the DB example bank is empty.

        Many skills ship hand-authored EXAMPLES.md content that today never
        reaches the model (few-shot injection is DB-only) — this recovers that
        authoring investment for cold-start skills without touching the DB path
        at all. Pairs any bold header containing "input" with the next bold
        header containing "output" (tolerates "**Input**:", "**Input**",
        "**Expected Output**", etc. — the wording varies across skills).
        Returns [] gracefully for any file that doesn't parse — this is a pure
        bonus source, never a regression versus today's DB-only behavior.
        """
        try:
            skill_dir = Path(skill_meta.get("_dir", "."))
            examples_path = skill_dir / skill_meta.get("examples", "EXAMPLES.md")
            if not examples_path.is_file():
                return []
            text = examples_path.read_text(encoding="utf-8")
            blocks = self._EXAMPLE_BLOCK_RE.findall(text)
            out: list[dict] = []
            i = 0
            while i < len(blocks) - 1:
                header_a, json_a = blocks[i]
                header_b, json_b = blocks[i + 1]
                if "input" in header_a.lower() and "output" in header_b.lower():
                    try:
                        out.append({
                            "input_json": json.loads(json_a),
                            "output_json": json.loads(json_b),
                            "eval_score": None,
                        })
                    except (json.JSONDecodeError, ValueError):
                        pass
                    i += 2
                else:
                    i += 1
            return out
        except Exception:
            return []

    async def _fetch_examples(self, skill_name: str) -> list[dict]:
        """Fetch top examples from skill_examples table. Returns [] gracefully on any error."""
        try:
            from crystalos.lib import db
            from crystalos.lib.constants import SKILL_EVAL_PASS_THRESHOLD
            rows = await db.execute_query(
                """SELECT input_json, output_json, eval_score
                   FROM skill_examples
                   WHERE skill_name = %s AND eval_score >= %s
                   ORDER BY eval_score DESC, created_at DESC
                   LIMIT 3""",
                (skill_name, SKILL_EVAL_PASS_THRESHOLD),
            )
            if not rows:
                return []
            return [
                {"input_json": r[0], "output_json": r[1], "eval_score": float(r[2])}
                for r in rows
            ]
        except Exception:
            return []

    # ── Eval engine ───────────────────────────────────────────────────────────

    def _baseline_output_check(self, output: dict) -> tuple[float, bool, list[str]]:
        """Minimal sanity gate for skills that ship no EVALS.md.

        Ensures the output is a non-empty dict carrying at least one field with
        substantive content — a string of >=20 chars or a non-empty list/dict.
        This replaces the old blind 0.85 auto-pass so un-evaluated skills still
        get a baseline quality bar, while staying field-name agnostic so novel
        skills are not falsely rejected.

        Pure-error payloads (e.g. {"error": "..."}) are treated as failures.
        """
        if not isinstance(output, dict) or not output:
            return 0.0, False, ["baseline: skill output is empty or not an object"]

        if "error" in output and len(output) == 1:
            return 0.0, False, ["baseline: skill output is an error payload"]

        for key, value in output.items():
            if key == "error":
                continue
            if isinstance(value, str) and len(value.strip()) >= 20:
                return 0.70, True, []
            if isinstance(value, (list, dict)) and len(value) > 0:
                return 0.70, True, []

        return 0.0, False, ["baseline: no substantive content field in output"]

    async def _check_evals(
        self,
        skill_meta: dict,
        input_data: dict,
        output: dict,
    ) -> tuple[float, bool, list[str]]:
        """Parse EVALS.md and check all criteria. Returns (score, passed, issues)."""
        from crystalos.lib.constants import SKILL_EVAL_PASS_THRESHOLD

        skill_dir = Path(skill_meta.get("_dir", "."))
        evals_path = skill_dir / skill_meta.get("evals", "EVALS.md")

        if not evals_path.exists():
            logger.warning(
                "skill_missing_evals",
                skill=skill_meta.get("name", "?"),
                msg="no EVALS.md — applying baseline output gate instead of auto-pass",
            )
            return self._baseline_output_check(output)

        try:
            criteria = self._parse_evals_md(evals_path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("evals_parse_error", skill=skill_meta.get("name", "?"), error=str(exc))
            return self._baseline_output_check(output)

        if not criteria:
            logger.warning("skill_empty_evals", skill=skill_meta.get("name", "?"))
            return self._baseline_output_check(output)

        issues: list[str] = []
        weighted_sum = 0.0
        weight_total = 0.0
        must_pass_failed = False
        skill_name = skill_meta.get("name")

        for crit in criteria:
            crit_id = crit["id"]
            threshold = crit["threshold"]
            weight = float(crit["weight"])
            desc = crit["description"].lower()

            score = await self._eval_criterion(
                desc, crit_id, input_data, output, weight, skill_name=skill_name
            )

            if threshold == "must pass":
                if score < 1.0:
                    issues.append(f"{crit_id}: FAILED — {crit['description'][:80]}")
                    must_pass_failed = True
            else:
                try:
                    thresh_f = float(str(threshold).lstrip(">= ").strip())
                except ValueError:
                    thresh_f = SKILL_EVAL_PASS_THRESHOLD
                weighted_sum += score * weight
                weight_total += weight
                if score < thresh_f:
                    issues.append(
                        f"{crit_id}: score={score:.2f} < {thresh_f} — {crit['description'][:60]}"
                    )

        if must_pass_failed:
            return 0.0, False, issues

        if weight_total == 0:
            return 0.75, True, issues

        final_score = weighted_sum / weight_total
        passed = (final_score >= SKILL_EVAL_PASS_THRESHOLD) and not issues
        return round(final_score, 3), passed, issues

    def _parse_evals_md(self, text: str) -> list[dict]:
        """Extract criteria rows from EVALS.md markdown table."""
        criteria: list[dict] = []
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith("|"):
                continue
            parts = [p.strip() for p in line.split("|") if p.strip()]
            if len(parts) >= 4 and re.match(r"E\d+", parts[0]):
                try:
                    criteria.append({
                        "id": parts[0],
                        "description": parts[1],
                        "weight": float(parts[2]),
                        "threshold": parts[3].lower().strip(),
                    })
                except (ValueError, IndexError):
                    pass
        return criteria

    async def _eval_criterion(
        self,
        description: str,
        criterion_name: str,
        input_data: dict,
        output: dict,
        weight: float,
        skill_name: str | None = None,
    ) -> float:
        """Evaluate one criterion. Use keyword rules for structural checks,
        LLM judge for semantic/quality checks."""
        # Kind B extension point: a skill's own must-pass criteria can be graded
        # by exact Python logic, keyed by (skill_name, criterion_id), bypassing
        # the generic structural/LLM dispatch entirely for that one criterion.
        if skill_name is not None:
            validator = SKILL_CRITERION_VALIDATORS.get((skill_name, criterion_name))
            if validator is not None:
                return validator(input_data, output)

        # Deterministic pattern checks: tried before the keyword dispatch, but
        # only take effect when the exact shape matches — otherwise the
        # criterion falls through unchanged to the existing keyword-gated
        # structural check or the LLM judge below.
        entries_match = _ENTRIES_PATTERN.search(description)
        if entries_match:
            return _eval_entries_with_fields(entries_match, output)

        enum_match = _ENUM_PATTERN.search(description)
        if enum_match:
            return _eval_enum_membership(enum_match, output)

        if _is_structural_criterion(description):
            return self._eval_structural(description, output, input_data)

        # Semantic/quality criterion — use LLM judge
        output_str = json_dumps_safe(output)
        prompt = f"""You are an AI quality evaluator. Score this output on one criterion.

Criterion: {description}

Output:
---
{output_str[:3000]}
---

Score from 0.0 to 1.0:
- 0.0: completely fails the criterion
- 0.5: partially meets the criterion
- 1.0: fully meets the criterion

Respond with ONLY a decimal number (e.g. 0.7). No explanation."""

        try:
            from crystalos.lib.models import get_model
            import dataclasses
            eval_cfg = dataclasses.replace(get_model("insight_evaluate"), max_tokens=5, temperature=0.0)
            messages = [
                {"role": "system", "content": "You are an AI quality evaluator. Respond only with a number."},
                {"role": "user", "content": prompt},
            ]
            raw, _ = await _call_with_backoff(messages, eval_cfg)
            score = float(raw.strip())
            return max(0.0, min(1.0, score))
        except (ValueError, TypeError):
            return 0.5  # neutral fallback, not soft-pass
        except Exception:
            return 0.5  # neutral fallback on any LLM error

    def _eval_structural(
        self, description: str, output: dict, input_data: dict | None = None
    ) -> float:
        """Fast deterministic evaluation for structural criteria."""
        desc = description.lower()

        # Valid JSON — always 1.0 if we got here (output is already parsed dict)
        if "valid json" in desc:
            return 1.0 if isinstance(output, dict) and not output.get("error") else 0.0

        # Score only the fields the criterion names. Scoring every output key
        # instead lets a legitimately empty optional field (e.g. `action_proposals:
        # []`, which crystal-analyst's SKILL.md instructs) fail a must-pass gate.
        if "required fields" in desc or "non-empty" in desc:
            named = _named_output_fields(desc, output)
            keys = named if named else list(output.keys())
            non_empty = sum(1 for k in keys if output.get(k) not in (None, "", [], {}))
            return min(1.0, non_empty / max(len(keys), 1))

        # Count range check: "key_findings count is 3-5"
        m = re.search(r"(\w+(?:_\w+)*)\s+count\s+is\s+(\d+)-(\d+)", desc)
        if m:
            field, lo, hi = m.group(1), int(m.group(2)), int(m.group(3))
            val = output.get(field)
            if isinstance(val, list):
                return 1.0 if lo <= len(val) <= hi else max(0.3, 1.0 - abs(len(val) - lo) * 0.2)

        # Word count check
        if "word count" in desc or "words" in desc:
            match = re.search(r"(\d+)\s*words?", desc)
            if match:
                target = int(match.group(1))
                output_text = " ".join(str(v) for v in output.values() if v)
                actual = len(output_text.split())
                return 1.0 if actual >= target * 0.8 else actual / max(target * 0.8, 1)

        # Contains check
        if "contains" in desc:
            output_text = json_dumps_safe(output).lower()
            match = re.search(r'contains\s+"([^"]+)"', desc)
            if match:
                return 1.0 if match.group(1).lower() in output_text else 0.0

        # Default for other structural criteria: soft pass
        return 0.8

    async def _write_example_async(
        self,
        skill_name: str,
        skill_version: str,
        eval_score: float,
        input_data: dict,
        output: dict,
        ctx: dict,
    ) -> None:
        """Write a passing example to skill_examples with org cap + dedup checks."""
        _ORG_CAP_PCT = 0.20
        try:
            from crystalos.lib import db
            from crystalos.lib.constants import SKILL_EXAMPLE_MAX_PER_SKILL

            org_id = ctx.get("org_id")

            # Org cap check: skip if this org already holds >= 20% of all examples
            total_rows = await db.execute_query(
                "SELECT COUNT(*) FROM skill_examples WHERE skill_name = %s",
                (skill_name,),
            )
            total = int(total_rows[0][0]) if total_rows else 0
            org_rows = await db.execute_query(
                "SELECT COUNT(*) FROM skill_examples WHERE skill_name = %s AND org_id = %s",
                (skill_name, org_id),
            )
            org_count = int(org_rows[0][0]) if org_rows else 0
            cap = max(1, int(total * _ORG_CAP_PCT))
            if org_count >= cap and total > 0:
                logger.debug("skill_example_org_cap_reached", skill=skill_name, org_id=org_id)
                return

            # Near-duplicate check via embedding cosine similarity
            try:
                from crystalos.tools.embeddings import embed_text as _embed_text
                query_text = json_dumps_safe(input_data)
                emb = await _embed_text(query_text)
                if emb:
                    import asyncio as _aio
                    dup_rows = await db.execute_query(
                        """SELECT id FROM skill_examples
                           WHERE skill_name = %s
                           ORDER BY embedding <=> %s::vector LIMIT 1""",
                        (skill_name, emb),
                    )
                    if dup_rows:
                        logger.debug("skill_example_dedup_skipped", skill=skill_name)
                        return
            except Exception:
                pass  # Embedding or pgvector unavailable — skip dedup silently

            await db.execute_query(
                """INSERT INTO skill_examples
                   (skill_name, skill_version, eval_score, input_json, output_json, org_id)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (
                    skill_name,
                    skill_version,
                    round(eval_score, 4),
                    json_dumps_safe(input_data),
                    json_dumps_safe(output),
                    org_id,
                ),
            )
            await db.execute_query(
                "SELECT prune_skill_examples(%s, %s)",
                (skill_name, SKILL_EXAMPLE_MAX_PER_SKILL),
            )
        except Exception as exc:
            logger.debug("skill_example_write_failed", skill=skill_name, error=str(exc))


async def _consolidate_example_bank(skill_name: str) -> None:
    """Remove near-duplicate examples from the global example bank for a skill."""
    _SIM_THRESHOLD = 0.85
    try:
        from crystalos.lib import db
        from crystalos.tools.embeddings import embed_text as _embed_text

        rows = await db.execute_query(
            """SELECT id, input_json, output_json, eval_score
               FROM skill_examples WHERE skill_name = %s
               ORDER BY eval_score DESC""",
            (skill_name,),
        )
        if not rows:
            return

        kept: list[tuple] = []
        deleted: set[str] = set()
        emb_cache: dict[str, list[float]] = {}

        for row in rows:
            row_id, input_json, output_json, score = row
            if row_id in deleted:
                continue
            text = input_json or "{}"
            emb = emb_cache.get(row_id) or await _embed_text(text)
            if emb is not None:
                emb_cache[row_id] = emb
            if emb is None:
                kept.append(row)
                continue

            # Check cosine similarity against all kept embeddings
            is_dup = False
            for kept_row in kept:
                kept_id = kept_row[0]
                kept_emb = emb_cache.get(kept_id)
                if kept_emb:
                    dot = sum(a * b for a, b in zip(emb, kept_emb))
                    norm_a = sum(a * a for a in emb) ** 0.5
                    norm_b = sum(b * b for b in kept_emb) ** 0.5
                    sim = dot / (norm_a * norm_b) if norm_a and norm_b else 0.0
                    if sim >= _SIM_THRESHOLD:
                        is_dup = True
                        break

            if is_dup:
                deleted.add(row_id)
                await db.execute_query(
                    "DELETE FROM skill_examples WHERE id = %s",
                    (row_id,),
                )
                logger.debug("skill_example_consolidated", skill=skill_name, removed_id=row_id)
            else:
                kept.append(row)

    except Exception as exc:
        logger.warning("consolidate_example_bank_failed", skill=skill_name, error=str(exc))
