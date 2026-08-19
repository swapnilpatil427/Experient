"""Tests for agents/lib/skill_runtime.py

Covers: SkillResult shape, eval parsing, eval checking, retry logic, example write.
All LLM calls are mocked — no real API calls.
"""
from __future__ import annotations

import json
import textwrap
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from crystalos.lib.skill_runtime import SkillResult, SkillRuntime


# ── Helpers ───────────────────────────────────────────────────────────────────

def make_skill_meta(
    tmp_path: Path,
    name: str = "test-skill",
    body: str = "## Instructions\nReturn JSON.",
    evals_md: str | None = None,
    max_retries: int = 1,
    timeout: int = 30,
) -> dict:
    skill_dir = tmp_path / name
    skill_dir.mkdir(exist_ok=True)
    (skill_dir / "SKILL.md").write_text(f"---\nname: {name}\nversion: 1.0.0\n---\n{body}")

    if evals_md:
        (skill_dir / "EVALS.md").write_text(evals_md)

    return {
        "name": name,
        "version": "1.0.0",
        "shared": False,
        "description": "Test skill",
        "allowed_tools": [],
        "evals": "EVALS.md",
        "examples": "EXAMPLES.md",
        "max_output_tokens": 500,
        "max_retries": max_retries,
        "timeout_seconds": timeout,
        "_path": str(skill_dir / "SKILL.md"),
        "_dir": str(skill_dir),
        "_body": body,
    }


def make_mock_credit(model: str = "test-model", in_tok: int = 100, out_tok: int = 50):
    credit = MagicMock()
    credit.model = model
    credit.input_tokens = in_tok
    credit.output_tokens = out_tok
    return credit


# ── SkillResult dataclass ─────────────────────────────────────────────────────

def test_skill_result_fields():
    result = SkillResult(
        output={"result": "ok"},
        eval_score=0.9,
        eval_passed=True,
        eval_issues=[],
        retried=False,
        skill_name="test-skill",
        skill_version="1.0.0",
        model="gemini-flash",
        tokens_used=150,
        latency_ms=234.5,
    )
    assert result.output == {"result": "ok"}
    assert result.eval_score == 0.9
    assert result.eval_passed is True
    assert result.reasoning_trace == {}  # default


# ── Eval parsing ──────────────────────────────────────────────────────────────

def test_parse_evals_md_extracts_criteria():
    runtime = SkillRuntime()
    evals_text = textwrap.dedent("""        # Evals: test-skill
        ## Criteria
        | ID | Criterion | Weight | Threshold |
        |----|-----------|--------|-----------|
        | E1 | Output is valid JSON | 30 | must pass |
        | E2 | key_findings count is 3-5 | 40 | >= 0.80 |
        | E3 | actionable recommendations | 30 | >= 0.75 |
    """)
    criteria = runtime._parse_evals_md(evals_text)
    assert len(criteria) == 3
    assert criteria[0]["id"] == "E1"
    assert criteria[0]["threshold"] == "must pass"
    assert criteria[1]["weight"] == 40.0
    assert criteria[2]["threshold"] == ">= 0.75"


def test_parse_evals_md_empty_returns_empty():
    runtime = SkillRuntime()
    criteria = runtime._parse_evals_md("# No table here\nJust text.")
    assert criteria == []


@pytest.mark.parametrize(
    "skill_name",
    ["gap-analyst", "platform-gap-tracker", "xm-market-researcher"],
)
def test_previously_prose_format_evals_now_parse(skill_name):
    """Regression test: these 3 skills' EVALS.md used to be pure prose/bullet
    format with zero markdown pipe-table rows, so _parse_evals_md silently
    returned an empty criteria list and every call fell through to the
    baseline auto-pass gate. platform-gap-tracker's EVALS.md contains a
    must-pass safety rule (never auto-close GAP-001/002/003 SOC2/HIPAA/FedRAMP)
    that was never actually enforced as a result. Assert the fix: real
    criteria are now extracted for all three."""
    evals_path = (
        Path(__file__).resolve().parent.parent / "skills" / skill_name / "EVALS.md"
    )
    runtime = SkillRuntime()
    criteria = runtime._parse_evals_md(evals_path.read_text())
    assert len(criteria) > 0
    assert all(c["id"].startswith("E") for c in criteria)


def test_platform_gap_tracker_soc2_rule_is_must_pass():
    """The specific safety-critical criterion must be a must-pass gate, not
    a soft-weighted score, so any violation zeroes the whole skill score."""
    evals_path = (
        Path(__file__).resolve().parent.parent
        / "skills"
        / "platform-gap-tracker"
        / "EVALS.md"
    )
    runtime = SkillRuntime()
    criteria = runtime._parse_evals_md(evals_path.read_text())
    soc2_criteria = [
        c
        for c in criteria
        if "GAP-001" in c["description"] and "GAP-002" in c["description"]
    ]
    assert len(soc2_criteria) == 1
    assert soc2_criteria[0]["threshold"] == "must pass"


# ── Eval criterion evaluation ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_eval_valid_json_passes_for_dict():
    runtime = SkillRuntime()
    score = await runtime._eval_criterion("output is valid json matching output schema", "E1", {}, {"result": "ok"}, 1.0)
    assert score == 1.0


@pytest.mark.asyncio
async def test_eval_valid_json_fails_for_error():
    runtime = SkillRuntime()
    score = await runtime._eval_criterion("output is valid json", "E1", {}, {"error": "failed"}, 1.0)
    assert score == 0.0


@pytest.mark.asyncio
async def test_eval_required_fields():
    runtime = SkillRuntime()
    score = await runtime._eval_criterion("required fields are present and non-empty", "E1", {}, {"a": "x", "b": "y", "c": ""}, 1.0)
    assert score > 0.5  # 2/3 non-empty


@pytest.mark.asyncio
async def test_eval_count_range_exact():
    runtime = SkillRuntime()
    output = {"key_findings": [1, 2, 3, 4]}  # 4 — in range 3-5
    score = await runtime._eval_criterion("key_findings count is 3-5", "E1", {}, output, 1.0)
    assert score == 1.0


@pytest.mark.asyncio
async def test_eval_count_range_out_of_range():
    runtime = SkillRuntime()
    output = {"key_findings": [1, 2]}  # 2 — below range
    score = await runtime._eval_criterion("key_findings count is 3-5", "E1", {}, output, 1.0)
    assert score < 1.0


@pytest.mark.asyncio
async def test_eval_actionable_with_specific_actions():
    runtime = SkillRuntime()
    output = {"recommended_actions": [
        "Assign the support team to audit the onboarding flow within 14 days",
        "Create a new FAQ page for common setup questions",
    ]}
    # "actionable" is a semantic criterion — mock _call_with_backoff to return a high score
    with patch("crystalos.lib.skill_runtime._call_with_backoff", new=AsyncMock(return_value=("0.9", {}))):
        score = await runtime._eval_criterion("recommended_actions are specific and actionable", "E1", {}, output, 1.0)
    assert score > 0.7


@pytest.mark.asyncio
async def test_eval_default_soft_pass():
    runtime = SkillRuntime()
    # Unknown quality criterion → LLM judge; when LLM returns valid score, use it
    with patch("crystalos.lib.skill_runtime._call_with_backoff", new=AsyncMock(return_value=("0.8", {}))):
        score = await runtime._eval_criterion("some unknown criterion description", "E1", {}, {"result": "ok"}, 1.0)
    assert score == pytest.approx(0.8)


# ── check_evals integration ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_check_evals_no_evals_file(tmp_path: Path):
    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path, name="no-evals-skill")
    # No EVALS.md created — falls back to baseline output gate (not a blind auto-pass).
    # A valid content field with substantial text passes at 0.70.
    score, passed, issues = await runtime._check_evals(
        meta, {}, {"answer": "This is a substantive answer that clears the baseline length bar."}
    )
    assert passed is True
    assert score == 0.70


@pytest.mark.asyncio
async def test_check_evals_no_evals_file_empty_output_fails(tmp_path: Path):
    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path, name="no-evals-skill")
    # No EVALS.md and an empty/garbage output — baseline gate must FAIL, not auto-pass.
    score, passed, issues = await runtime._check_evals(meta, {}, {})
    assert passed is False
    assert score == 0.0
    assert len(issues) > 0


@pytest.mark.asyncio
async def test_check_evals_no_evals_file_no_content_field_fails(tmp_path: Path):
    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path, name="no-evals-skill")
    # Output dict with no recognised content field — baseline gate fails.
    score, passed, issues = await runtime._check_evals(meta, {}, {"random_key": "x"})
    assert passed is False
    assert score == 0.0


@pytest.mark.asyncio
async def test_check_evals_must_pass_fail_returns_zero(tmp_path: Path):
    evals = textwrap.dedent("""        # Evals
        ## Criteria
        | ID | Criterion | Weight | Threshold |
        |----|-----------|--------|-----------|
        | E1 | Output is valid JSON matching output schema | 30 | must pass |
    """)
    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path, evals_md=evals)
    # Pass an error dict (fails E1)
    score, passed, issues = await runtime._check_evals(meta, {}, {"error": "something failed"})
    assert score == 0.0
    assert passed is False
    assert len(issues) > 0


@pytest.mark.asyncio
async def test_check_evals_all_numeric_pass(tmp_path: Path):
    evals = textwrap.dedent("""        # Evals
        ## Criteria
        | ID | Criterion | Weight | Threshold |
        |----|-----------|--------|-----------|
        | E1 | Output is valid JSON | 30 | must pass |
        | E2 | key_findings count is 3-5 | 70 | >= 0.80 |
    """)
    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path, evals_md=evals)
    output = {"key_findings": [{"finding": "x"}, {"finding": "y"}, {"finding": "z"}]}
    score, passed, issues = await runtime._check_evals(meta, {}, output)
    assert score >= 0.75


# ── System prompt building ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_build_system_includes_body(tmp_path: Path):
    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path, body="## Test\nMy special instructions.")
    # Mock _fetch_examples to return empty
    with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=[])):
        system = await runtime._build_system(meta, {})
    assert "My special instructions" in system


@pytest.mark.asyncio
async def test_build_system_includes_references(tmp_path: Path):
    skill_dir = tmp_path / "ref-skill"
    skill_dir.mkdir()
    refs_dir = skill_dir / "references"
    refs_dir.mkdir()
    (refs_dir / "best-practices.md").write_text("# XM Best Practices\nNPS should be measured quarterly.")

    meta = {
        "name": "ref-skill",
        "version": "1.0.0",
        "_dir": str(skill_dir),
        "_body": "## Context\nI use references.",
        "evals": "EVALS.md",
        "examples": "EXAMPLES.md",
        "max_output_tokens": 500,
        "max_retries": 1,
        "timeout_seconds": 30,
    }
    runtime = SkillRuntime()
    with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=[])):
        system = await runtime._build_system(meta, {})
    assert "NPS should be measured quarterly" in system


@pytest.mark.asyncio
async def test_build_system_includes_examples(tmp_path: Path):
    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path, body="## Instructions\nUse examples.")
    examples = [
        {"input_json": {"q": "What is NPS?"}, "output_json": {"answer": "NPS is..."}, "eval_score": 0.9}
    ]
    with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=examples)):
        system = await runtime._build_system(meta, {})
    assert "High-Quality Examples from Production" in system
    assert "What is NPS?" in system


@pytest.mark.asyncio
async def test_build_system_falls_back_to_examples_md_when_db_empty(tmp_path: Path):
    """Skills with no production history yet (empty DB example bank) should
    still get few-shot examples from their own hand-authored EXAMPLES.md,
    rather than silently getting none — this is dead authoring effort today
    for skills whose EXAMPLES.md is never actually read."""
    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path, body="## Instructions\nUse examples.")
    examples_md = textwrap.dedent("""
        # Examples: test-skill

        ## Example 1: Straightforward case

        **Input**:
        ```json
        {"q": "What is NPS?"}
        ```

        **Output**:
        ```json
        {"answer": "NPS is a loyalty metric."}
        ```
    """)
    (Path(meta["_dir"]) / "EXAMPLES.md").write_text(examples_md)

    with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=[])):
        system = await runtime._build_system(meta, {})
    assert "High-Quality Examples from Production" in system
    assert "What is NPS?" in system
    assert "seed example" in system


@pytest.mark.asyncio
async def test_build_system_prefers_db_examples_over_examples_md(tmp_path: Path):
    """DB-sourced (proven-in-production) examples always win over the
    EXAMPLES.md fallback when both exist — never merge the two."""
    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path, body="## Instructions\nUse examples.")
    (Path(meta["_dir"]) / "EXAMPLES.md").write_text(textwrap.dedent("""
        **Input**:
        ```json
        {"q": "from file"}
        ```
        **Output**:
        ```json
        {"answer": "should not appear"}
        ```
    """))
    db_examples = [
        {"input_json": {"q": "from db"}, "output_json": {"answer": "from db wins"}, "eval_score": 0.9}
    ]
    with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=db_examples)):
        system = await runtime._build_system(meta, {})
    assert "from db" in system
    assert "should not appear" not in system


def test_parse_examples_md_fallback_handles_header_variance():
    """Different skills phrase example headers differently ('**Input**:',
    '**Input**', '**Expected Output**') — the parser must tolerate all of
    them, and skip gracefully (not raise) on anything unparseable."""
    runtime = SkillRuntime()
    meta = {"_dir": "/nonexistent-dir-should-return-empty", "examples": "EXAMPLES.md"}
    assert runtime._parse_examples_md_fallback(meta) == []


@pytest.mark.parametrize(
    "skill_name",
    ["workflow-analyst", "metric-parity", "crystal-support"],
)
def test_parse_examples_md_fallback_against_real_skill_files(skill_name):
    """Confirm the fallback parser actually extracts examples from real,
    currently-shipped EXAMPLES.md files across skills with different header
    conventions ('**Input**:'/'**Output**:' vs '**Input**'/'**Expected
    Output**'), not just a synthetic fixture."""
    runtime = SkillRuntime()
    skill_dir = Path(__file__).resolve().parent.parent / "skills" / skill_name
    meta = {"_dir": str(skill_dir), "examples": "EXAMPLES.md"}
    examples = runtime._parse_examples_md_fallback(meta)
    assert len(examples) > 0
    for ex in examples:
        assert isinstance(ex["input_json"], dict)
        assert isinstance(ex["output_json"], dict)
        assert ex["eval_score"] is None


def test_parse_examples_md_fallback_auto_generated_placeholder_returns_empty():
    """The auto-generated placeholder EXAMPLES.md (no real content, most
    skills have this today) must return [] — not raise, not fabricate."""
    runtime = SkillRuntime()
    skill_dir = Path(__file__).resolve().parent.parent / "skills" / "crystal-analyst"
    meta = {"_dir": str(skill_dir), "examples": "EXAMPLES.md"}
    assert runtime._parse_examples_md_fallback(meta) == []


# ── Execute with mocked LLM ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_execute_serializes_uuid_input(tmp_path: Path):
    """Postgres UUID objects in skill input must not break json.dumps for the LLM user message."""
    from uuid import uuid4

    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path)
    uid = uuid4()

    mock_output = MagicMock()
    mock_output.to_dict.return_value = {"answer": "Analysis complete with enough text for baseline."}
    mock_credit = make_mock_credit()

    captured_user: dict = {}

    async def capturing_call_agent(*args, **kwargs):
        captured_user["user"] = kwargs.get("user", args[2] if len(args) > 2 else "")
        return mock_output, mock_credit

    with patch("crystalos.lib.openrouter.call_agent", capturing_call_agent):
        with patch("crystalos.lib.models.get_skill_model") as mock_model:
            from crystalos.lib.models import ModelConfig
            mock_model.return_value = ModelConfig(model="test/model", max_tokens=500, temperature=0.1)
            with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=[])):
                await runtime.execute(
                    "test-skill",
                    meta,
                    {"survey_id": uid, "insights": [{"id": uid}]},
                    {"org_id": "org1"},
                )

    assert str(uid) in captured_user["user"]


@pytest.mark.asyncio
async def test_execute_returns_skill_result(tmp_path: Path):
    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path)

    mock_output = MagicMock()
    mock_output.to_dict.return_value = {"result": "success", "findings": ["f1", "f2", "f3"]}
    mock_credit = make_mock_credit()

    with patch("crystalos.lib.openrouter.call_agent", AsyncMock(return_value=(mock_output, mock_credit))):
        with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=[])):
            result = await runtime.execute("test-skill", meta, {"input": "test"}, {"org_id": "org1"})

    assert isinstance(result, SkillResult)
    assert result.skill_name == "test-skill"
    assert result.skill_version == "1.0.0"
    assert result.output == {"result": "success", "findings": ["f1", "f2", "f3"]}
    assert result.tokens_used == 150
    assert result.latency_ms > 0


@pytest.mark.asyncio
async def test_execute_retries_on_eval_failure(tmp_path: Path):
    evals = textwrap.dedent("""        # Evals
        ## Criteria
        | ID | Criterion | Weight | Threshold |
        |----|-----------|--------|-----------|
        | E1 | Output is valid JSON | 30 | must pass |
        | E2 | key_findings count is 3-5 | 70 | >= 0.80 |
    """)
    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path, evals_md=evals, max_retries=1)

    # First call returns bad output (only 1 finding), second returns good output
    bad_output = MagicMock()
    bad_output.to_dict.return_value = {"key_findings": [{"f": "only one"}]}
    good_output = MagicMock()
    good_output.to_dict.return_value = {"key_findings": [{"f": "one"}, {"f": "two"}, {"f": "three"}]}
    mock_credit = make_mock_credit()

    call_count = 0

    async def mock_call_agent(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return bad_output, mock_credit
        return good_output, mock_credit

    with patch("crystalos.lib.openrouter.call_agent", mock_call_agent):
        with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=[])):
            result = await runtime.execute("test-skill", meta, {}, {})

    assert result.retried is True
    assert call_count == 2


@pytest.mark.asyncio
async def test_execute_timeout_returns_error_result(tmp_path: Path):
    import asyncio
    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path, timeout=1)

    async def slow_call(*args, **kwargs):
        await asyncio.sleep(10)  # Much longer than timeout

    with patch("crystalos.lib.openrouter.call_agent", slow_call):
        with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=[])):
            result = await runtime.execute("test-skill", meta, {}, {})

    assert result.eval_passed is False
    assert "Timed out" in (result.output.get("error") or "")
    assert result.eval_score == 0.0


@pytest.mark.asyncio
async def test_execute_exception_returns_error_result(tmp_path: Path):
    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path)

    with patch("crystalos.lib.openrouter.call_agent", AsyncMock(side_effect=RuntimeError("API down"))):
        with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=[])):
            result = await runtime.execute("test-skill", meta, {}, {})

    assert result.eval_passed is False
    assert "API down" in result.output.get("error", "")


@pytest.mark.asyncio
async def test_execute_passes_model_config_to_call_agent(tmp_path: Path):
    """execute() must pass model_config=<pre-resolved config> to call_agent,
    not rely on call_agent's internal get_model() lookup."""
    from crystalos.lib.models import ModelConfig

    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path)

    skill_model = ModelConfig(model="skill/model:free", max_tokens=200, temperature=0.2)
    mock_output = MagicMock()
    mock_output.to_dict.return_value = {"result": "ok"}
    mock_credit = make_mock_credit()

    captured_kwargs: dict = {}

    async def capturing_call_agent(*args, **kwargs):
        captured_kwargs.update(kwargs)
        return mock_output, mock_credit

    with patch("crystalos.lib.openrouter.call_agent", capturing_call_agent):
        with patch("crystalos.lib.models.get_skill_model", return_value=skill_model):
            with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=[])):
                await runtime.execute("test-skill", meta, {}, {})

    assert "model_config" in captured_kwargs, "model_config kwarg must be passed to call_agent"
    passed_cfg = captured_kwargs["model_config"]
    assert passed_cfg.model == skill_model.model
    assert passed_cfg.max_tokens == 200  # min(skill max_output_tokens=500, model max_tokens=200)


@pytest.mark.asyncio
async def test_execute_retry_also_passes_model_config(tmp_path: Path):
    """On retry (eval failure), call_agent must also receive model_config."""
    from crystalos.lib.models import ModelConfig

    evals = textwrap.dedent("""        # Evals
        | ID | Criterion | Weight | Threshold |
        |----|-----------|--------|-----------|
        | E1 | key_findings count is 3-5 | 100 | >= 0.90 |
    """)
    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path, evals_md=evals, max_retries=1)

    skill_model = ModelConfig(model="retry/model:free", max_tokens=150, temperature=0.1)
    bad_output = MagicMock()
    bad_output.to_dict.return_value = {"key_findings": [{"f": "only one"}]}
    good_output = MagicMock()
    good_output.to_dict.return_value = {"key_findings": [{"f": "1"}, {"f": "2"}, {"f": "3"}]}
    mock_credit = make_mock_credit()

    all_kwargs: list[dict] = []
    call_count = 0

    async def capturing_call_agent(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        all_kwargs.append(dict(kwargs))
        if call_count == 1:
            return bad_output, mock_credit
        return good_output, mock_credit

    with patch("crystalos.lib.openrouter.call_agent", capturing_call_agent):
        with patch("crystalos.lib.models.get_skill_model", return_value=skill_model):
            with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=[])):
                result = await runtime.execute("test-skill", meta, {}, {})

    assert result.retried is True
    assert call_count == 2
    for i, kwargs in enumerate(all_kwargs):
        cfg = kwargs.get("model_config")
        assert cfg is not None, f"model_config not passed on call {i + 1}"
        assert cfg.model == skill_model.model
        assert cfg.max_tokens == 150


@pytest.mark.asyncio
async def test_execute_applies_skill_max_output_tokens_cap(tmp_path: Path):
    """SKILL.md max_output_tokens must cap the model config passed to call_agent."""
    from crystalos.lib.models import ModelConfig

    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path)
    meta["max_output_tokens"] = 500

    skill_model = ModelConfig(model="skill/model:free", max_tokens=2000, temperature=0.2)
    mock_output = MagicMock()
    mock_output.to_dict.return_value = {"result": "ok"}
    mock_credit = make_mock_credit()

    captured_kwargs: dict = {}

    async def capturing_call_agent(*args, **kwargs):
        captured_kwargs.update(kwargs)
        return mock_output, mock_credit

    with patch("crystalos.lib.openrouter.call_agent", capturing_call_agent):
        with patch("crystalos.lib.models.get_skill_model", return_value=skill_model):
            with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=[])):
                await runtime.execute("test-skill", meta, {}, {})

    assert captured_kwargs["model_config"].max_tokens == 500


@pytest.mark.asyncio
async def test_execute_does_not_call_get_model_directly(tmp_path: Path):
    """execute() uses get_skill_model(), not get_model(). Calling get_model() with a
    skill name raises KeyError — so if execute() ever falls back to get_model() the
    test will fail."""
    from crystalos.lib.models import ModelConfig

    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path)

    skill_model = ModelConfig(model="test/model:free", max_tokens=100, temperature=0.1)
    mock_output = MagicMock()
    mock_output.to_dict.return_value = {"result": "ok"}

    with patch("crystalos.lib.openrouter.call_agent", AsyncMock(return_value=(mock_output, make_mock_credit()))):
        with patch("crystalos.lib.models.get_skill_model", return_value=skill_model):
            # If get_model() is called anywhere inside execute(), it will raise KeyError
            with patch("crystalos.lib.openrouter.get_model", side_effect=KeyError("must not call get_model")):
                with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=[])):
                    result = await runtime.execute("nps-action-advisor", meta, {}, {})

    assert result.eval_passed is True or result.eval_score >= 0
    # If we got here, get_model() was never called — test passes


# ── Structural presence-criterion scoring (regression, 2026-08-04) ────────────
#
# Two distinct live defects, both on `must pass` criteria (which fail on any
# score < 1.0), found while planning the assistant-ui migration:
#
#   1. `_eval_structural` divided non-empty-field count by len(output) across
#      EVERY key, not just the fields the criterion names. A criterion naming 3
#      fields was scored against all 5 output keys, so a legitimately empty
#      optional field (`action_proposals: []`, which crystal-analyst's SKILL.md
#      explicitly instructs the model to emit) hard-failed the gate.
#   2. "non-empty" was absent from STRUCTURAL_KEYWORDS, so "<fields> present and
#      non-empty" criteria never reached the structural path at all — they went
#      to the LLM judge, where `must pass` could only be satisfied by the judge
#      emitting the exact string "1.0".

def test_eval_structural_scores_only_named_fields():
    """crystal-analyst E2 names 3 fields; empty optional keys must not fail it."""
    runtime = SkillRuntime()
    output = {
        "answer": "NPS fell 8 points, driven by wait time.",
        "citations": ["c1"],
        "suggestions": ["What changed in the wait-time topic?"],
        "insight_refs": [],        # legitimately empty
        "action_proposals": [],    # SKILL.md says to emit [] when nothing to propose
    }
    score = runtime._eval_structural(
        "answer, citations, suggestions present and non-empty", output
    )
    assert score == 1.0, (
        "must-pass gate requires exactly 1.0; empty optional fields the criterion "
        "does not name must not reduce the score"
    )


def test_eval_structural_ignores_future_viz_field():
    """Forward-looking regression for the generative-UI migration.

    `viz` does not exist on `CrystalOutput` yet — this is deliberately not part
    of that work (see docs/harness-engineering/assistant-ui-migration/PLAN_CONTRACT.md §2.4). But
    crystal-analyst's E2 is `must pass`, and once `viz` is added as an optional
    field, an empty `viz: []` on every chart-free turn must not drag E2 below
    1.0. E2 names only answer/citations/suggestions, so `viz` must be ignored
    exactly like `insight_refs`/`action_proposals` are today.
    """
    runtime = SkillRuntime()
    output = {
        "answer": "NPS fell 8 points, driven by wait time.",
        "citations": ["c1"],
        "suggestions": ["What changed in the wait-time topic?"],
        "insight_refs": [],
        "action_proposals": [],
        "viz": [],  # hypothetical future field — empty on most turns
    }
    score = runtime._eval_structural(
        "answer, citations, suggestions present and non-empty", output
    )
    assert score == 1.0, (
        "adding an optional viz field must never fail crystal-analyst's "
        "must-pass E2 on a chart-free turn"
    )


def test_eval_structural_named_fields_still_fails_when_a_named_field_is_empty():
    """The fix must not make the check vacuous — a named empty field still fails."""
    runtime = SkillRuntime()
    output = {"answer": "text", "citations": [], "suggestions": ["s"], "extra": []}
    score = runtime._eval_structural(
        "answer, citations, suggestions present and non-empty", output
    )
    assert score < 1.0
    assert score == pytest.approx(2 / 3)


def test_eval_structural_colon_delimited_field_list():
    """insight-narrator E2 lists its fields after a colon."""
    runtime = SkillRuntime()
    output = {
        "title": "T",
        "executive_summary": "S",
        "key_findings": ["f"],
        "recommended_actions": ["a"],
        "confidence": 0.9,
        "debug_meta": {},  # not named — must be ignored
    }
    score = runtime._eval_structural(
        "Required fields present and non-empty: title, executive_summary, "
        "key_findings, recommended_actions, confidence",
        output,
    )
    assert score == 1.0


def test_eval_structural_falls_back_to_all_keys_when_no_field_named():
    """Unrecognised phrasing keeps the historical all-keys behaviour."""
    runtime = SkillRuntime()
    output = {"alpha": "x", "beta": ""}
    score = runtime._eval_structural("required fields must be non-empty", output)
    assert score == pytest.approx(0.5)


def test_present_and_non_empty_criterion_routes_to_structural_path():
    """Defect 2: these criteria must be deterministic, not LLM-judged."""
    from crystalos.lib.skill_runtime import _is_structural_criterion

    for desc in (
        "answer, citations, suggestions present and non-empty",                     # crystal-analyst / tag-analyst
        "questions, explanation, changes present and non-empty",                    # copilot-analyst
        "headline, narrative, effort_analysis, friction_points present and non-empty",  # specialist-ces
        "headline, narrative, loyalty_analysis, segment_insights present and non-empty",  # specialist-nps
    ):
        assert _is_structural_criterion(desc.lower()) is True, desc


def test_conditional_presence_criterion_stays_semantic():
    """Guard the deliberate exclusion of bare "present".

    crystal-support E5 is conditional logic, not a presence check, and must keep
    going to the LLM judge. If someone adds "present" to STRUCTURAL_KEYWORDS this
    fails — which is the intent.
    """
    from crystalos.lib.skill_runtime import _is_structural_criterion

    assert _is_structural_criterion(
        "escalation_package is present when resolved=false and absent when resolved=true".lower()
    ) is False


def test_named_output_fields_ignores_unrelated_tokens():
    from crystalos.lib.skill_runtime import _named_output_fields

    output = {"answer": 1, "citations": 2, "suggestions": 3}
    assert _named_output_fields("answer and citations present", output) == ["answer", "citations"]
    assert _named_output_fields("no field names here at all", output) == []


# ── Task A: input_data threading fix + broadened deterministic checks ────────

@pytest.mark.asyncio
async def test_eval_criterion_forwards_input_data_to_eval_structural():
    """Regression: _eval_criterion used to receive input_data but never forward
    it into _eval_structural, and _eval_structural's signature didn't even
    accept it. Both are now threaded through."""
    runtime = SkillRuntime()
    captured: dict = {}
    original = runtime._eval_structural

    def spy(description, output, input_data=None):
        captured["input_data"] = input_data
        return original(description, output, input_data)

    with patch.object(runtime, "_eval_structural", side_effect=spy):
        await runtime._eval_criterion(
            "required fields are present and non-empty", "E1", {"marker": "x"}, {"a": "1"}, 1.0
        )
    assert captured["input_data"] == {"marker": "x"}


def test_eval_structural_default_input_data_is_none():
    """Existing internal callers that don't pass input_data must keep working."""
    runtime = SkillRuntime()
    score = runtime._eval_structural("valid json", {"a": "1"})
    assert score == 1.0


# -- "N-M entries with fields" pattern --

@pytest.mark.asyncio
async def test_entries_with_fields_synthetic_pass():
    runtime = SkillRuntime()
    output = {
        "actions": [
            {"id": "a1", "type": "create_workflow", "priority": "high", "title": "t1", "description": "d1", "params": {"survey_id": "s1"}},
            {"id": "a2", "type": "create_alert", "priority": "medium", "title": "t2", "description": "d2", "params": {"x": 1}},
        ]
    }
    score = await runtime._eval_criterion(
        "actions has 1-4 entries with id, type, priority, title, description, params",
        "E2", {}, output, 25.0,
    )
    assert score == 1.0


@pytest.mark.asyncio
async def test_entries_with_fields_wrong_count_fails():
    runtime = SkillRuntime()
    score = await runtime._eval_criterion(
        "actions has 1-4 entries with id, type, priority, title, description, params",
        "E2", {}, {"actions": []}, 25.0,
    )
    assert score == 0.0


@pytest.mark.asyncio
async def test_entries_with_fields_missing_required_key_fails():
    runtime = SkillRuntime()
    output = {
        "actions": [
            # "params" present but "description" is empty — must count as missing
            {"id": "a1", "type": "create_workflow", "priority": "high", "title": "t1", "description": "", "params": {}},
        ]
    }
    score = await runtime._eval_criterion(
        "actions has 1-4 entries with id, type, priority, title, description, params",
        "E2", {}, output, 25.0,
    )
    assert score == 0.0


@pytest.mark.asyncio
async def test_entries_with_fields_non_matching_shape_falls_through_to_structural():
    """"contains" is a STRUCTURAL_KEYWORDS hit, so a criterion that mentions
    "entries with" but doesn't match the rigid N-M shape must still land on
    the existing generic structural handling (soft-pass default), not a new
    hard 0.0."""
    runtime = SkillRuntime()
    score = await runtime._eval_criterion(
        "actions contains entries with proper details", "E1", {}, {"actions": []}, 1.0,
    )
    assert score == 0.8


# -- "is one of: a, b, c" enum-membership pattern --

@pytest.mark.asyncio
async def test_enum_membership_synthetic_pass():
    runtime = SkillRuntime()
    score = await runtime._eval_criterion(
        "effort_level is one of: low, moderate, high, critical", "E3", {}, {"effort_level": "high"}, 10.0,
    )
    assert score == 1.0


@pytest.mark.asyncio
async def test_enum_membership_invalid_value_fails():
    runtime = SkillRuntime()
    score = await runtime._eval_criterion(
        "effort_level is one of: low, moderate, high, critical", "E3", {}, {"effort_level": "extreme"}, 10.0,
    )
    assert score == 0.0


@pytest.mark.asyncio
async def test_enum_pattern_non_matching_shape_falls_through_to_llm():
    """Ordinary prose containing "is one of" (no colon, not a criterion shape)
    must not be captured by the new regex — it has no STRUCTURAL_KEYWORDS hit
    either, so it must reach the LLM judge unchanged."""
    runtime = SkillRuntime()
    mock_llm = AsyncMock(return_value=("0.6", {}))
    with patch("crystalos.lib.skill_runtime._call_with_backoff", mock_llm):
        score = await runtime._eval_criterion(
            "the rating is one of the best examples we've seen", "E1", {}, {"rating": "good"}, 1.0,
        )
    mock_llm.assert_called_once()
    assert score == pytest.approx(0.6)


# -- LLM never invoked for the new deterministic shapes, but is invoked for an
#    unrelated semantic criterion on the same skill --

@pytest.mark.asyncio
async def test_deterministic_criteria_skip_llm_but_semantic_criterion_uses_it(tmp_path: Path):
    evals = textwrap.dedent("""        # Evals
        ## Criteria
        | ID | Criterion | Weight | Threshold |
        |----|-----------|--------|-----------|
        | E1 | actions has 1-4 entries with id, type, priority, title, description, params | 40 | must pass |
        | E2 | effort_level is one of: low, moderate, high, critical | 10 | must pass |
        | E3 | actions are specific and actionable | 50 | >= 0.75 |
    """)
    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path, evals_md=evals)
    output = {
        "actions": [
            {"id": "a1", "type": "create_workflow", "priority": "high", "title": "t", "description": "d", "params": {"k": 1}},
        ],
        "effort_level": "high",
    }
    mock_llm = AsyncMock(return_value=("0.9", {}))
    with patch("crystalos.lib.skill_runtime._call_with_backoff", mock_llm):
        score, passed, issues = await runtime._check_evals(meta, {}, output)

    mock_llm.assert_called_once()  # only E3 (the semantic criterion) reaches the judge
    assert passed is True


# -- Real criteria pulled from actual EVALS.md files --

@pytest.mark.asyncio
@pytest.mark.parametrize("skill_name", ["csat-action-advisor", "nps-action-advisor"])
async def test_real_entries_with_fields_criterion_scores_deterministically(skill_name):
    evals_path = Path(__file__).resolve().parent.parent / "skills" / skill_name / "EVALS.md"
    runtime = SkillRuntime()
    criteria = runtime._parse_evals_md(evals_path.read_text())
    e2 = next(c for c in criteria if c["id"] == "E2")
    assert "entries with" in e2["description"].lower()

    output = {
        "actions": [
            {
                "id": "a1", "type": "create_workflow", "priority": "high",
                "title": "Follow up with detractors", "description": "d",
                "business_rationale": "r", "params": {"segment": "detractors"}, "estimated_time": "1 day",
                "touchpoint_targeted": "support", "csat_impact_estimate": "+0.3",
            },
        ]
    }
    mock_llm = AsyncMock(return_value=("0.9", {}))
    with patch("crystalos.lib.skill_runtime._call_with_backoff", mock_llm):
        score = await runtime._eval_criterion(e2["description"].lower(), e2["id"], {}, output, e2["weight"])

    assert score == 1.0
    mock_llm.assert_not_called()


@pytest.mark.asyncio
async def test_real_enum_criterion_scores_deterministically():
    evals_path = Path(__file__).resolve().parent.parent / "skills" / "specialist-csat" / "EVALS.md"
    runtime = SkillRuntime()
    criteria = runtime._parse_evals_md(evals_path.read_text())
    e3 = next(c for c in criteria if c["id"] == "E3")
    assert "is one of" in e3["description"].lower()

    mock_llm = AsyncMock(return_value=("0.9", {}))
    with patch("crystalos.lib.skill_runtime._call_with_backoff", mock_llm):
        score = await runtime._eval_criterion(
            e3["description"].lower(), e3["id"], {}, {"csat_rating": "needs_improvement"}, e3["weight"]
        )

    assert score == 1.0
    mock_llm.assert_not_called()


@pytest.mark.asyncio
async def test_crystal_support_conditional_presence_still_routes_to_llm():
    """crystal-support E5 ("present iff resolved=false") must stay on the LLM
    path — it doesn't match either new regex and must not be miscaptured."""
    evals_path = Path(__file__).resolve().parent.parent / "skills" / "crystal-support" / "EVALS.md"
    runtime = SkillRuntime()
    criteria = runtime._parse_evals_md(evals_path.read_text())
    e5 = next(c for c in criteria if c["id"] == "E5")

    mock_llm = AsyncMock(return_value=("1.0", {}))
    with patch("crystalos.lib.skill_runtime._call_with_backoff", mock_llm):
        score = await runtime._eval_criterion(
            e5["description"].lower(), e5["id"], {}, {"resolved": False, "escalation_package": {}}, e5["weight"]
        )

    mock_llm.assert_called_once()
    assert score == 1.0


# ── Task B: Kind A extension point — _OUTPUT_TRANSFORMS + PII wiring ─────────

def test_output_transforms_run_in_registration_order(monkeypatch):
    import crystalos.lib.skill_runtime as sr

    order: list[str] = []

    def t1(d: dict) -> dict:
        order.append("t1")
        out = dict(d)
        out["t1"] = True
        return out

    def t2(d: dict) -> dict:
        order.append("t2")
        assert d.get("t1") is True  # t1 must have already run
        out = dict(d)
        out["t2"] = True
        return out

    monkeypatch.setattr(sr, "_OUTPUT_TRANSFORMS", [t1, t2])

    result: dict = {}
    for transform in sr._OUTPUT_TRANSFORMS:
        result = transform(result)

    assert order == ["t1", "t2"]
    assert result == {"t1": True, "t2": True}


def test_register_output_transform_appends_and_returns_fn():
    import crystalos.lib.skill_runtime as sr

    original = list(sr._OUTPUT_TRANSFORMS)
    try:
        def my_transform(d: dict) -> dict:
            return d

        returned = sr.register_output_transform(my_transform)
        assert returned is my_transform
        assert sr._OUTPUT_TRANSFORMS[-1] is my_transform
    finally:
        sr._OUTPUT_TRANSFORMS[:] = original


@pytest.mark.asyncio
async def test_execute_runs_output_transforms_in_order(tmp_path: Path, monkeypatch):
    import crystalos.lib.skill_runtime as sr

    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path)

    calls: list[str] = []

    def t1(d: dict) -> dict:
        calls.append("t1")
        out = dict(d)
        out["seen_t1"] = True
        return out

    def t2(d: dict) -> dict:
        calls.append("t2")
        assert d.get("seen_t1") is True
        out = dict(d)
        out["seen_t2"] = True
        return out

    monkeypatch.setattr(sr, "_OUTPUT_TRANSFORMS", [t1, t2])

    mock_output = MagicMock()
    mock_output.to_dict.return_value = {"answer": "Enough substantive text to clear the baseline gate here."}
    mock_credit = make_mock_credit()

    with patch("crystalos.lib.openrouter.call_agent", AsyncMock(return_value=(mock_output, mock_credit))):
        with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=[])):
            result = await runtime.execute("test-skill", meta, {}, {}, write_example=False)

    assert calls == ["t1", "t2"]
    assert result.output["seen_t1"] is True
    assert result.output["seen_t2"] is True


@pytest.mark.asyncio
async def test_execute_output_transform_exception_is_fail_open(tmp_path: Path, monkeypatch):
    import crystalos.lib.skill_runtime as sr

    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path)

    def bad_transform(d: dict) -> dict:
        raise RuntimeError("boom")

    monkeypatch.setattr(sr, "_OUTPUT_TRANSFORMS", [bad_transform])

    mock_output = MagicMock()
    original_output = {"answer": "Enough substantive text to clear the baseline gate here."}
    mock_output.to_dict.return_value = dict(original_output)
    mock_credit = make_mock_credit()

    with patch("crystalos.lib.openrouter.call_agent", AsyncMock(return_value=(mock_output, mock_credit))):
        with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=[])):
            result = await runtime.execute("test-skill", meta, {}, {}, write_example=False)

    # A raising transform must never propagate or corrupt the output.
    assert result.eval_passed is True
    assert result.output == original_output


@pytest.mark.asyncio
async def test_execute_scrubs_pii_before_example_bank_write(tmp_path: Path):
    """End-to-end: PII in a skill's raw output must be scrubbed both in the
    returned SkillResult.output AND in what reaches the example-bank write."""
    import asyncio as _asyncio

    evals = textwrap.dedent("""        # Evals
        ## Criteria
        | ID | Criterion | Weight | Threshold |
        |----|-----------|--------|-----------|
        | E1 | Output is valid JSON | 30 | must pass |
    """)
    runtime = SkillRuntime()
    meta = make_skill_meta(tmp_path, evals_md=evals)

    mock_output = MagicMock()
    mock_output.to_dict.return_value = {
        "answer": "Contact John at john.doe@example.com for details, thanks so much."
    }
    mock_credit = make_mock_credit()

    captured: dict = {}

    async def fake_write_example(**kwargs):
        captured.update(kwargs)

    with patch("crystalos.lib.openrouter.call_agent", AsyncMock(return_value=(mock_output, mock_credit))):
        with patch.object(runtime, "_fetch_examples", AsyncMock(return_value=[])):
            with patch.object(runtime, "_write_example_async", side_effect=fake_write_example):
                result = await runtime.execute(
                    "test-skill", meta, {"q": "x"}, {"org_id": "org1"}, write_example=True
                )
                await _asyncio.sleep(0)  # let the fire-and-forget create_task run

    assert "john.doe@example.com" not in result.output["answer"]
    assert "[EMAIL]" in result.output["answer"]
    assert captured, "expected _write_example_async to have been scheduled"
    assert "john.doe@example.com" not in captured["output"]["answer"]
    assert "[EMAIL]" in captured["output"]["answer"]


# ── Task C: Kind B extension point — SKILL_CRITERION_VALIDATORS wiring ───────

_WF_REGISTRY = {
    "triggers": [{"type": "score.nps_drop", "category": "Score", "label": "NPS dropped"}],
    "conditionFields": [{"field": "nps", "label": "NPS score", "kind": "number"}],
    "conditionOperators": ["lt"],
    "actions": [{"action": "notify.slack", "category": "Notify", "label": "Slack message", "live": True}],
}


def _wf_proposal() -> dict:
    return {
        "type": "create_workflow",
        "title": "Alert on NPS drop",
        "description": "NPS dropped below threshold",
        "params": {
            "trigger_type": "score.nps_drop",
            "nodes": [
                {"id": "trigger-1", "type": "trigger", "trigger": "score.nps_drop"},
                {
                    "id": "condition-1",
                    "type": "condition",
                    "conditions": {"operator": "AND", "rules": [{"field": "nps", "op": "lt", "value": 30}]},
                },
                {"id": "action-1", "type": "action", "action": "notify.slack", "config": {}},
            ],
            "edges": [{"from": "trigger-1", "to": "condition-1"}, {"from": "condition-1", "to": "action-1"}],
            "confidence": 0.9,
            "warnings": [],
        },
        "priority": "high",
        "requires_confirmation": True,
    }


@pytest.mark.asyncio
async def test_compliance_scanner_e5_routes_to_validator_not_llm():
    runtime = SkillRuntime()
    mock_llm = AsyncMock(return_value=("1.0", {}))
    output = {"issues": [{"category": "gdpr", "regulation_reference": "GDPR Art. 9"}]}
    with patch("crystalos.lib.skill_runtime._call_with_backoff", mock_llm):
        score = await runtime._eval_criterion(
            "gdpr issues include regulation_reference", "E5", {}, output, 15.0, skill_name="compliance-scanner",
        )
    assert score == 1.0
    mock_llm.assert_not_called()


@pytest.mark.asyncio
async def test_compliance_scanner_unrelated_criterion_still_uses_llm():
    """E4 is NOT in SKILL_CRITERION_VALIDATORS — proves the lookup is scoped
    precisely to the registered (skill, criterion) pairs, not the whole skill."""
    runtime = SkillRuntime()
    mock_llm = AsyncMock(return_value=("0.9", {}))
    output = {"issues": [{"category": "gdpr", "severity": "major", "description": "d", "recommendation": "r"}]}
    with patch("crystalos.lib.skill_runtime._call_with_backoff", mock_llm):
        score = await runtime._eval_criterion(
            "each issue has category, severity, description, and recommendation",
            "E4", {}, output, 25.0, skill_name="compliance-scanner",
        )
    mock_llm.assert_called_once()
    assert score == pytest.approx(0.9)


@pytest.mark.asyncio
async def test_workflow_analyst_e2_routes_to_validator_not_llm():
    runtime = SkillRuntime()
    mock_llm = AsyncMock(return_value=("1.0", {}))
    input_data = {"survey_facts": {"workflow_registry": _WF_REGISTRY}}
    output = {"action_proposals": [_wf_proposal()]}
    with patch("crystalos.lib.skill_runtime._call_with_backoff", mock_llm):
        score = await runtime._eval_criterion(
            "every action_proposals[].params.trigger_type / condition field / action exists "
            "in the supplied registry",
            "E2", input_data, output, 20.0, skill_name="workflow-analyst",
        )
    assert score == 1.0
    mock_llm.assert_not_called()


@pytest.mark.asyncio
async def test_workflow_analyst_unrelated_criterion_still_uses_llm():
    """E5 is NOT in SKILL_CRITERION_VALIDATORS — same skill, different
    criterion, must still fall through to the LLM judge."""
    runtime = SkillRuntime()
    mock_llm = AsyncMock(return_value=("0.85", {}))
    output = {"action_proposals": []}
    with patch("crystalos.lib.skill_runtime._call_with_backoff", mock_llm):
        score = await runtime._eval_criterion(
            "business_rationale/description on any proposal cites a real number or fact",
            "E5", {}, output, 15.0, skill_name="workflow-analyst",
        )
    mock_llm.assert_called_once()
    assert score == pytest.approx(0.85)


@pytest.mark.asyncio
async def test_check_evals_workflow_analyst_real_file_routes_e2_e3_e6_deterministically():
    """Integration test through _check_evals using the real workflow-analyst
    EVALS.md: E2/E3/E6 must never reach the LLM judge; E4/E5/E7 (not
    registered validators) must."""
    skill_dir = Path(__file__).resolve().parent.parent / "skills" / "workflow-analyst"
    meta = {"name": "workflow-analyst", "_dir": str(skill_dir), "evals": "EVALS.md"}
    runtime = SkillRuntime()
    input_data = {"survey_facts": {"workflow_registry": _WF_REGISTRY}}
    output = {
        "answer": "That maps to score.nps_drop.",
        "citations": ["score.nps_drop"],
        "suggestions": ["Want a Slack notification too?"],
        "action_proposals": [_wf_proposal()],
    }
    mock_llm = AsyncMock(return_value=("0.9", {}))
    with patch("crystalos.lib.skill_runtime._call_with_backoff", mock_llm):
        await runtime._check_evals(meta, input_data, output)

    # E1 is structural ("valid json"); E2/E3/E6 hit the deterministic
    # validators; only E4, E5, E7 remain for the LLM judge.
    assert mock_llm.call_count == 3


@pytest.mark.asyncio
async def test_check_evals_compliance_scanner_real_file_routes_e5_deterministically():
    skill_dir = Path(__file__).resolve().parent.parent / "skills" / "compliance-scanner"
    meta = {"name": "compliance-scanner", "_dir": str(skill_dir), "evals": "EVALS.md"}
    runtime = SkillRuntime()
    output = {
        "compliance_score": 80,
        "passed": True,
        "requires_privacy_notice": True,
        "requires_legal_review": False,
        "issues": [
            {
                "question_id": "q1",
                "category": "gdpr",
                "severity": "major",
                "description": "collects health data without opt-in",
                "regulation_reference": "GDPR Art. 9",
                "recommendation": "add explicit opt-in notice",
            }
        ],
        "recommendations": ["Add opt-in for health data question."],
    }
    mock_llm = AsyncMock(return_value=("0.9", {}))
    with patch("crystalos.lib.skill_runtime._call_with_backoff", mock_llm):
        await runtime._check_evals(meta, {}, output)

    # E1 is structural ("valid json"); E5 hits the deterministic validator;
    # E2/E3/E4 (no matching structural keyword or deterministic pattern) fall
    # through to the LLM judge.
    assert mock_llm.call_count == 3


def test_skill_criterion_validators_importable_from_skill_runtime():
    """skill_runtime.py must actually import and use the shared registry, not
    a private copy — this would fail if the import were ever dropped."""
    from crystalos.lib.skill_runtime import SKILL_CRITERION_VALIDATORS
    from crystalos.lib.skill_validators import SKILL_CRITERION_VALIDATORS as canonical

    assert SKILL_CRITERION_VALIDATORS is canonical
