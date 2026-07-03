"""Unit tests for the Crystal conversational AI analyst agent."""
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from crystalos.agents.crystal import (
    CrystalAgent,
    CrystalInput,
    CrystalOutput,
    ReActStep,
    ReActToolCall,
    _build_insights_context,
    _build_topics_context,
    _build_metrics_context,
    _build_system_prompt,
    ActionProposal,
    _normalize_skill_output,
    _resolve_crystal_skill_match,
    _skill_synthesis,
    _run_skill_loop,
    _run_skill_stream,
    _fetch_skill_context,
)
from crystalos.lib.skill_runtime import SkillResult
from tests.conftest import make_credit


def _schema_aware_call_agent(react_steps, answer_output=None):
    """Return an async call_agent stub that returns successive ReActStep objects for the
    planning phase (output_schema=ReActStep) and a CrystalOutput for the synthesis phase.

    react_steps: list of ReActStep returned in order for each planning call (last one repeats).
    """
    answer_output = answer_output or _make_output()
    state = {"i": 0}

    async def _fn(agent_name, system, user, output_schema, current_tokens=0, prior_messages=None):
        if getattr(output_schema, "__name__", "") == "ReActStep":
            i = min(state["i"], len(react_steps) - 1)
            state["i"] += 1
            return (react_steps[i], make_credit("crystal"))
        return (answer_output, make_credit("crystal"))

    return _fn


# ── Fixtures ─────────────────────────────────────────────────────────────────────

SAMPLE_INSIGHTS = [
    {
        "id": "ins-001",
        "layer": "descriptive",
        "category": "metric.nps",
        "headline": "NPS score is 42",
        "narrative": "Based on 250 responses, promoters outnumber detractors 2:1.",
        "metric_json": {"value": 42, "sample_size": 250},
        "trust_score": 0.95,
    },
    {
        "id": "ins-002",
        "layer": "diagnostic",
        "category": "driver.negative",
        "headline": "Shipping delays drive 38% of detractors",
        "narrative": "Customers who rated shipping negatively gave NPS scores below 4.",
        "metric_json": {"pct": 38},
        "trust_score": 0.87,
    },
    {
        "id": "ins-003",
        "layer": "prescriptive",
        "category": "action",
        "headline": "Prioritize shipping SLA improvement",
        "narrative": "Reducing average delivery time by 1 day is estimated to lift NPS by 6 points.",
        "metric_json": None,
        "trust_score": 0.72,
    },
]

SAMPLE_TOPICS = [
    {"name": "Shipping", "volume": 120, "sentiment_score": -0.4, "dominant_emotion": "frustration", "effort_score": 0.8, "trending": True},
    {"name": "Product Quality", "volume": 80, "sentiment_score": 0.7, "dominant_emotion": "delight", "effort_score": 0.2, "trending": False},
]

SAMPLE_METRICS = {
    "nps":  {"score": 42, "n": 250},
    "csat": {"score": 3.8, "n": 180},
    "response_count": 250,
}


@pytest.fixture
def agent():
    return CrystalAgent()


@pytest.fixture
def basic_input():
    return CrystalInput(
        survey_id="survey-abc",
        org_id="org-xyz",
        message="What is driving our low NPS?",
        insights=SAMPLE_INSIGHTS,
        topics=SAMPLE_TOPICS,
        survey_title="Q1 2025 Customer Satisfaction",
        survey_response_count=250,
        metrics=SAMPLE_METRICS,
    )


def _make_output(answer="The main driver of low NPS is shipping delays.", **kwargs):
    return CrystalOutput(
        answer=answer,
        citations=kwargs.get("citations", ["ins-002"]),
        suggestions=kwargs.get("suggestions", [
            "Which shipping regions are worst affected?",
            "How does this compare to last quarter?",
            "What should we do to improve shipping scores?",
        ]),
        insight_refs=kwargs.get("insight_refs", ["ins-002"]),
    )


# ── CrystalInput model validation ────────────────────────────────────────────────

def test_crystal_input_minimal():
    """CrystalInput works with only required fields."""
    inp = CrystalInput(
        survey_id="s1",
        org_id="o1",
        message="Tell me about this survey.",
        insights=[],
    )
    assert inp.survey_id == "s1"
    assert inp.org_id == "o1"
    assert inp.topics == []
    assert inp.conversation_history == []
    assert inp.metrics == {}
    assert inp.survey_response_count == 0


def test_crystal_input_with_all_fields():
    """CrystalInput correctly stores all optional fields."""
    history = [
        {"role": "user", "content": "What is NPS?"},
        {"role": "assistant", "content": "NPS is Net Promoter Score."},
    ]
    inp = CrystalInput(
        survey_id="s2",
        org_id="o2",
        message="What's driving low NPS?",
        insights=SAMPLE_INSIGHTS,
        topics=SAMPLE_TOPICS,
        survey_title="My Survey",
        survey_response_count=300,
        metrics=SAMPLE_METRICS,
        conversation_history=history,
    )
    assert inp.survey_title == "My Survey"
    assert inp.survey_response_count == 300
    assert len(inp.conversation_history) == 2
    assert len(inp.insights) == 3
    assert len(inp.topics) == 2


def test_crystal_input_rejects_missing_required_fields():
    """CrystalInput raises ValidationError when required fields are missing."""
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        CrystalInput(org_id="o1", message="hello", insights=[])  # missing survey_id


# ── System prompt construction ────────────────────────────────────────────────────

def test_system_prompt_contains_survey_title(basic_input):
    """System prompt includes the survey title."""
    prompt = _build_system_prompt(basic_input)
    assert "Q1 2025 Customer Satisfaction" in prompt


def test_system_prompt_contains_insight_ids(basic_input):
    """System prompt includes insight IDs in brackets so Crystal can cite them."""
    prompt = _build_system_prompt(basic_input)
    assert "[ins-001]" in prompt
    assert "[ins-002]" in prompt
    assert "[ins-003]" in prompt


def test_system_prompt_contains_insight_headlines(basic_input):
    """System prompt includes insight headlines."""
    prompt = _build_system_prompt(basic_input)
    assert "NPS score is 42" in prompt
    assert "Shipping delays drive 38% of detractors" in prompt


def test_system_prompt_contains_topics(basic_input):
    """System prompt includes topic names."""
    prompt = _build_system_prompt(basic_input)
    assert "Shipping" in prompt
    assert "Product Quality" in prompt


def test_system_prompt_contains_metrics(basic_input):
    """System prompt includes key metrics."""
    prompt = _build_system_prompt(basic_input)
    assert "42" in prompt      # NPS score
    assert "250" in prompt     # response count


def test_system_prompt_instructs_no_survey_changes(basic_input):
    """System prompt tells Crystal not to recommend survey question changes."""
    prompt = _build_system_prompt(basic_input)
    assert "survey builder" in prompt.lower() or "copilot" in prompt.lower()


def test_system_prompt_uses_layer_grouping():
    """Insights are grouped by their layer (descriptive, diagnostic, etc.)."""
    inp = CrystalInput(
        survey_id="s",
        org_id="o",
        message="hi",
        insights=SAMPLE_INSIGHTS,
    )
    prompt = _build_system_prompt(inp)
    assert "WHAT (Descriptive)" in prompt
    assert "WHY (Diagnostic)" in prompt
    assert "ACTIONS (Prescriptive)" in prompt


# ── Context builder helpers ───────────────────────────────────────────────────────

def test_build_insights_context_empty():
    """Empty insight list returns a fallback message."""
    text, ids = _build_insights_context([])
    assert "No insights" in text
    assert ids == set()


def test_build_insights_context_groups_by_layer():
    """Insights are grouped by their layer heading."""
    text, ids = _build_insights_context(SAMPLE_INSIGHTS)
    assert "Descriptive" in text
    assert "Diagnostic" in text
    assert "Prescriptive" in text
    assert "ins-001" in text


def test_build_topics_context_empty():
    """Empty topics returns a sensible fallback."""
    result = _build_topics_context([])
    assert "No topics" in result


def test_build_topics_context_includes_topic_names():
    result = _build_topics_context(SAMPLE_TOPICS)
    assert "Shipping" in result
    assert "Product Quality" in result


def test_build_metrics_context_with_nps():
    result = _build_metrics_context({"nps": {"score": 42, "n": 200}}, response_count=200)
    assert "42" in result
    assert "200" in result


def test_build_metrics_context_empty():
    result = _build_metrics_context({}, 0)
    assert "No key metrics" in result


# ── Agent run: mocked LLM call ────────────────────────────────────────────────────

async def test_crystal_agent_run_returns_answer(agent, basic_input):
    """Agent.run() returns a CrystalOutput with a non-empty answer."""
    output = _make_output()
    credit = make_credit("crystal")

    with patch("crystalos.agents.crystal.call_agent", new=AsyncMock(return_value=(output, credit))):
        result, credits = await agent.run(basic_input)

    assert isinstance(result, CrystalOutput)
    assert len(result.answer) > 0
    assert isinstance(credits, list)


async def test_crystal_agent_run_returns_suggestions(agent, basic_input):
    """Agent returns 2-3 follow-up suggestions."""
    output = _make_output()
    credit = make_credit("crystal")

    with patch("crystalos.agents.crystal.call_agent", new=AsyncMock(return_value=(output, credit))):
        result, _ = await agent.run(basic_input)

    assert len(result.suggestions) >= 1


async def test_crystal_agent_run_returns_citations(agent, basic_input):
    """Agent returns citation IDs from the insight list."""
    output = _make_output(citations=["ins-001", "ins-002"])
    credit = make_credit("crystal")

    with patch("crystalos.agents.crystal.call_agent", new=AsyncMock(return_value=(output, credit))):
        result, _ = await agent.run(basic_input)

    assert "ins-001" in result.citations or "ins-002" in result.citations


async def test_crystal_agent_passes_conversation_history(agent):
    """Conversation history is passed to the LLM as prior_messages."""
    history = [
        {"role": "user",      "content": "What is our NPS?"},
        {"role": "assistant", "content": "Your NPS is 42."},
    ]
    inp = CrystalInput(
        survey_id="s",
        org_id="o",
        message="Why is it 42?",
        insights=SAMPLE_INSIGHTS,
        conversation_history=history,
    )
    output = _make_output()
    credit = make_credit("crystal")

    captured = {}

    async def capture(agent_name, system, user, output_schema, current_tokens=0, prior_messages=None):
        captured["prior_messages"] = prior_messages
        return (output, credit)

    with patch("crystalos.agents.crystal.call_agent", new=capture):
        await agent.run(inp)

    # prior_messages should contain the history
    assert captured.get("prior_messages") is not None
    assert len(captured["prior_messages"]) == 2
    assert captured["prior_messages"][0]["role"] == "user"


async def test_crystal_agent_truncates_long_history(agent):
    """Conversation history is truncated to last CRYSTAL_CONVERSATION_WINDOW * 2 messages."""
    from crystalos.lib.constants import CRYSTAL_CONVERSATION_WINDOW
    window = CRYSTAL_CONVERSATION_WINDOW * 2
    # Create more messages than the window to trigger truncation
    history = [
        {"role": "user" if i % 2 == 0 else "assistant", "content": f"message {i}"}
        for i in range(window + 4)
    ]
    inp = CrystalInput(
        survey_id="s",
        org_id="o",
        message="Follow-up question",
        insights=[],
        conversation_history=history,
    )
    output = _make_output()
    credit = make_credit("crystal")

    captured = {}

    async def capture(agent_name, system, user, output_schema, current_tokens=0, prior_messages=None):
        captured["prior_messages"] = prior_messages
        return (output, credit)

    with patch("crystalos.agents.crystal.call_agent", new=capture):
        await agent.run(inp)

    assert len(captured["prior_messages"]) <= window


async def test_crystal_agent_no_history_passes_none(agent):
    """When no conversation history, prior_messages is None."""
    inp = CrystalInput(
        survey_id="s",
        org_id="o",
        message="First question ever",
        insights=SAMPLE_INSIGHTS,
        conversation_history=[],
    )
    output = _make_output()
    credit = make_credit("crystal")

    captured = {}

    async def capture(agent_name, system, user, output_schema, current_tokens=0, prior_messages=None):
        captured["prior_messages"] = prior_messages
        return (output, credit)

    with patch("crystalos.agents.crystal.call_agent", new=capture):
        await agent.run(inp)

    assert captured.get("prior_messages") is None


async def test_crystal_agent_uses_crystal_agent_name(agent, basic_input):
    """Crystal always calls the LLM with agent_name='crystal'."""
    output = _make_output()
    credit = make_credit("crystal")

    captured = {}

    async def capture(agent_name, system, user, output_schema, current_tokens=0, prior_messages=None):
        captured["agent_name"] = agent_name
        return (output, credit)

    with patch("crystalos.agents.crystal.call_agent", new=capture):
        await agent.run(basic_input)

    assert captured["agent_name"] == "crystal"


async def test_crystal_agent_user_message_passed_correctly(agent):
    """The user's exact message is forwarded as the `user` argument to call_agent."""
    inp = CrystalInput(
        survey_id="s",
        org_id="o",
        message="Summarize findings for my VP",
        insights=SAMPLE_INSIGHTS,
    )
    output = _make_output()
    credit = make_credit("crystal")

    captured = {}

    async def capture(agent_name, system, user, output_schema, current_tokens=0, prior_messages=None):
        captured["user"] = user
        return (output, credit)

    with patch("crystalos.agents.crystal.call_agent", new=capture):
        await agent.run(inp)

    assert captured["user"] == "Summarize findings for my VP"


# ── CrystalOutput model ───────────────────────────────────────────────────────────

def test_crystal_output_defaults():
    """CrystalOutput optional fields default to empty lists."""
    out = CrystalOutput(answer="Some answer")
    assert out.citations == []
    assert out.suggestions == []
    assert out.insight_refs == []


def test_crystal_output_full():
    """CrystalOutput stores all fields correctly."""
    out = CrystalOutput(
        answer="NPS is driven by shipping.",
        citations=["ins-002"],
        suggestions=["What regions are worst?", "How to fix shipping?"],
        insight_refs=["ins-002", "ins-003"],
    )
    assert out.answer == "NPS is driven by shipping."
    assert len(out.citations) == 1
    assert len(out.suggestions) == 2
    assert len(out.insight_refs) == 2


def test_crystal_output_coerces_navigation_suggestion_dicts():
    """Regression: LLM may emit navigation dicts in suggestions — coerce to label strings."""
    out = CrystalOutput(
        answer="Detractors cite slow support.",
        suggestions=[
            {"type": "navigation", "route": "/app/insights", "label": "View Detractor sentiment"},
            "What is driving detractors?",
        ],
    )
    assert out.suggestions == ["View Detractor sentiment", "What is driving detractors?"]


# ── TestGetOrCreateThread ─────────────────────────────────────────────────────────

class TestGetOrCreateThread:
    """Tests for get_or_create_thread() in agents/agents/crystal.py."""

    def _make_ctx(self, org_id="org-1", user_id="user-1", survey_id="survey-1", scope="survey"):
        from dataclasses import dataclass

        @dataclass
        class FakeCtx:
            org_id: str
            user_id: str
            survey_id: str
            scope: str

        return FakeCtx(org_id=org_id, user_id=user_id, survey_id=survey_id, scope=scope)

    def _make_mock_pool(self, fetchone_return=None):
        """Return a MagicMock that mimics db._pool_conn().connection().__aenter__."""
        mock_cur = AsyncMock()
        mock_cur.execute = AsyncMock()
        mock_cur.fetchone = AsyncMock(return_value=fetchone_return)
        mock_cur.description = []
        mock_cur.__aenter__ = AsyncMock(return_value=mock_cur)
        mock_cur.__aexit__ = AsyncMock(return_value=False)

        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock()
        mock_conn.commit = AsyncMock()
        mock_conn.cursor = MagicMock(return_value=mock_cur)
        mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_conn.__aexit__ = AsyncMock(return_value=False)

        mock_pool_ctx = MagicMock()
        mock_pool_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool_ctx.__aexit__ = AsyncMock(return_value=False)

        mock_pool = MagicMock()
        mock_pool.connection = MagicMock(return_value=mock_pool_ctx)

        return mock_pool, mock_cur, mock_conn

    @pytest.mark.asyncio
    async def test_thread_continues_when_recently_active(self):
        """Thread is returned as-is when last_active_at is < 7 days ago."""
        from datetime import datetime, timezone, timedelta
        from crystalos.agents.crystal import get_or_create_thread

        recent = datetime.now(timezone.utc) - timedelta(days=2)
        thread_row = ("thread-uuid-1", [{"role": "user", "content": "hi"}], recent, 1)

        mock_pool, mock_cur, mock_conn = self._make_mock_pool(fetchone_return=thread_row)

        with patch("crystalos.lib.db._pool_conn", return_value=mock_pool):
            result = await get_or_create_thread(self._make_ctx(), db_pool=None)

        assert result["id"] == "thread-uuid-1"
        assert result["is_new"] is False
        assert isinstance(result["messages"], list)

    @pytest.mark.asyncio
    async def test_thread_resets_when_stale(self):
        """Thread resets (is_new=True) when last_active_at is 8+ days ago."""
        from datetime import datetime, timezone, timedelta
        from crystalos.agents.crystal import get_or_create_thread

        stale = datetime.now(timezone.utc) - timedelta(days=9)
        thread_row = ("thread-uuid-2", [], stale, 5)

        mock_pool, mock_cur, mock_conn = self._make_mock_pool(fetchone_return=thread_row)

        with patch("crystalos.lib.db._pool_conn", return_value=mock_pool):
            result = await get_or_create_thread(self._make_ctx(), db_pool=None)

        assert result["is_new"] is True
        assert result["messages"] == []

    @pytest.mark.asyncio
    async def test_new_thread_created_when_none_exists(self):
        """Returns is_new=True when no thread exists for the user/survey."""
        from crystalos.agents.crystal import get_or_create_thread

        import uuid
        new_id = uuid.uuid4()

        mock_cur = AsyncMock()
        mock_cur.execute = AsyncMock()
        # First fetchone: no existing thread; second fetchone: new row id
        mock_cur.fetchone = AsyncMock(side_effect=[None, (new_id,)])
        mock_cur.description = []
        mock_cur.__aenter__ = AsyncMock(return_value=mock_cur)
        mock_cur.__aexit__ = AsyncMock(return_value=False)

        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock()
        mock_conn.commit = AsyncMock()
        mock_conn.cursor = MagicMock(return_value=mock_cur)
        mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_conn.__aexit__ = AsyncMock(return_value=False)

        mock_pool_ctx = MagicMock()
        mock_pool_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool_ctx.__aexit__ = AsyncMock(return_value=False)

        mock_pool = MagicMock()
        mock_pool.connection = MagicMock(return_value=mock_pool_ctx)

        with patch("crystalos.lib.db._pool_conn", return_value=mock_pool):
            result = await get_or_create_thread(self._make_ctx(), db_pool=None)

        assert result["is_new"] is True
        assert result["messages"] == []

    @pytest.mark.asyncio
    async def test_db_failure_returns_safe_fallback(self):
        """DB failure returns safe fallback dict without raising."""
        from crystalos.agents.crystal import get_or_create_thread

        mock_pool = MagicMock()
        mock_pool.connection = MagicMock(side_effect=Exception("DB down"))

        with patch("crystalos.lib.db._pool_conn", return_value=mock_pool):
            result = await get_or_create_thread(self._make_ctx(), db_pool=None)

        assert result["id"] is None
        assert result["messages"] == []
        assert result["is_new"] is True


# ── TestReactLoop ─────────────────────────────────────────────────────────────────

class TestReactLoop:
    """Tests for _run_react_loop()."""

    def _make_input(self, **kwargs):
        defaults = dict(
            survey_id="s-1",
            org_id="org-1",
            message="What is our NPS?",
            insights=SAMPLE_INSIGHTS,
            topics=SAMPLE_TOPICS,
            metrics=SAMPLE_METRICS,
        )
        defaults.update(kwargs)
        return CrystalInput(**defaults)

    @pytest.mark.asyncio
    async def test_returns_crystal_output_with_answer(self):
        """_run_react_loop returns a CrystalOutput with a non-empty answer."""
        from crystalos.agents.crystal import _run_react_loop

        call_agent_stub = _schema_aware_call_agent([ReActStep(action="final", answer="done")])

        with (
            patch("crystalos.agents.crystal.call_agent", new=call_agent_stub),
            patch("crystalos.agents.crystal._build_system_prompt_agentic", return_value="system prompt"),
            patch("crystalos.agents.crystal.evaluate_crystal_response", new=AsyncMock(side_effect=Exception("no eval"))),
            patch("redis.asyncio.from_url", new=AsyncMock(side_effect=Exception("no redis"))),
        ):
            result = await _run_react_loop(self._make_input())

        assert isinstance(result, CrystalOutput)
        assert len(result.answer) > 0

    @pytest.mark.asyncio
    async def test_rate_limit_exceeded_raises_value_error(self):
        """When Redis rate limit count > 10, raises ValueError."""
        from crystalos.agents.crystal import _run_react_loop

        mock_redis = AsyncMock()
        mock_redis.incr = AsyncMock(return_value=11)
        mock_redis.expire = AsyncMock()
        mock_redis.close = AsyncMock()

        with patch("redis.asyncio.from_url", new=AsyncMock(return_value=mock_redis)):
            with pytest.raises(ValueError, match="Rate limit"):
                await _run_react_loop(self._make_input())

    @pytest.mark.asyncio
    async def test_history_limited_to_conversation_window(self):
        """History passed to call_agent is limited to CRYSTAL_CONVERSATION_WINDOW * 2 messages."""
        from crystalos.agents.crystal import _run_react_loop
        from crystalos.lib.constants import CRYSTAL_CONVERSATION_WINDOW

        # Build history with more than the window
        long_history = [
            {"role": "user" if i % 2 == 0 else "assistant", "content": f"msg {i}"}
            for i in range(CRYSTAL_CONVERSATION_WINDOW * 2 + 6)
        ]

        captured = {}

        async def capture_call(agent_name, system, user, output_schema, current_tokens=0, prior_messages=None):
            captured["prior_messages"] = prior_messages
            if getattr(output_schema, "__name__", "") == "ReActStep":
                return (ReActStep(action="final", answer="done"), make_credit("crystal"))
            return (_make_output(), make_credit("crystal"))

        with (
            patch("crystalos.agents.crystal.call_agent", new=capture_call),
            patch("crystalos.agents.crystal._build_system_prompt_agentic", return_value="sys"),
            patch("crystalos.agents.crystal.evaluate_crystal_response", new=AsyncMock(side_effect=Exception("no eval"))),
            patch("redis.asyncio.from_url", new=AsyncMock(side_effect=Exception("no redis"))),
        ):
            await _run_react_loop(self._make_input(conversation_history=long_history))

        prior = captured.get("prior_messages") or []
        assert len(prior) <= CRYSTAL_CONVERSATION_WINDOW * 2


# ── TestReactLoopStreaming ─────────────────────────────────────────────────────────

class TestReactLoopStreaming:
    """Tests for _run_react_loop_streaming()."""

    def _make_input(self, **kwargs):
        defaults = dict(
            survey_id="s-1",
            org_id="org-1",
            message="What themes are emerging?",
            insights=SAMPLE_INSIGHTS,
        )
        defaults.update(kwargs)
        return CrystalInput(**defaults)

    async def _collect_events(self, inp, extra_patches=None):
        import json as _json
        from crystalos.agents.crystal import _run_react_loop_streaming

        events = []
        # dispatch_tool is imported locally inside the function, patch at source
        mock_dispatch = AsyncMock(return_value={"overview": "test data"})
        # Plan one tool call, then finalize; synthesis returns a CrystalOutput.
        mock_call_agent = _schema_aware_call_agent([
            ReActStep(action="tool_call", tool_calls=[ReActToolCall(tool="get_survey_overview", args={})]),
            ReActStep(action="final", answer="done"),
        ])

        patches_ctx = [
            patch("crystalos.crystal.tools.dispatch_tool", new=mock_dispatch),
            patch("crystalos.agents.crystal.call_agent", new=mock_call_agent),
            patch("crystalos.agents.crystal.evaluate_crystal_response", new=AsyncMock(side_effect=Exception("no eval"))),
            patch("redis.asyncio.from_url", new=AsyncMock(side_effect=Exception("no redis"))),
        ]
        if extra_patches:
            for target, mock_val in extra_patches.items():
                patches_ctx.append(patch(target, new=mock_val))

        import contextlib
        with contextlib.ExitStack() as stack:
            for p in patches_ctx:
                stack.enter_context(p)
            async for event_str in _run_react_loop_streaming(inp):
                events.append(_json.loads(event_str))

        return events

    @pytest.mark.asyncio
    async def test_events_contain_type_field(self):
        """All yielded events have a 'type' field."""
        events = await self._collect_events(self._make_input())
        assert all("type" in e for e in events)

    @pytest.mark.asyncio
    async def test_first_tool_event_is_thinking(self):
        """The first event per tool has type == 'thinking'."""
        events = await self._collect_events(self._make_input())
        thinking_events = [e for e in events if e.get("type") == "thinking"]
        assert len(thinking_events) >= 1

    @pytest.mark.asyncio
    async def test_observation_follows_thinking(self):
        """An 'observation' event follows each 'thinking' event when tool succeeds."""
        events = await self._collect_events(self._make_input())
        types = [e["type"] for e in events]
        # Find first thinking and verify observation comes after it
        if "thinking" in types:
            first_thinking_idx = types.index("thinking")
            # An observation should appear somewhere after the first thinking
            post_thinking_types = types[first_thinking_idx + 1:]
            assert "observation" in post_thinking_types

    @pytest.mark.asyncio
    async def test_synthesizing_event_before_answer(self):
        """A 'synthesizing' event is always emitted before the 'answer' event."""
        events = await self._collect_events(self._make_input())
        types = [e["type"] for e in events]
        assert "synthesizing" in types
        assert "answer" in types
        assert types.index("synthesizing") < types.index("answer")

    @pytest.mark.asyncio
    async def test_last_event_is_answer(self):
        """The last event has type == 'answer' with an 'answer' field."""
        events = await self._collect_events(self._make_input())
        assert len(events) > 0
        last = events[-1]
        assert last["type"] == "answer"
        assert "answer" in last

    @pytest.mark.asyncio
    async def test_rate_limit_first_event_is_error(self):
        """When rate limit is exceeded, first event is type == 'error'."""
        import json as _json
        from crystalos.agents.crystal import _run_react_loop_streaming

        mock_redis = AsyncMock()
        mock_redis.incr = AsyncMock(return_value=11)
        mock_redis.expire = AsyncMock()
        mock_redis.close = AsyncMock()

        events = []
        with patch("redis.asyncio.from_url", new=AsyncMock(return_value=mock_redis)):
            async for event_str in _run_react_loop_streaming(self._make_input()):
                events.append(_json.loads(event_str))

        assert len(events) >= 1
        assert events[0]["type"] == "error"


# ── TestBuildSystemPromptAgentic ──────────────────────────────────────────────────

class TestBuildSystemPromptAgentic:
    """Tests for _build_system_prompt_agentic()."""

    def _make_ctx(self, scope="survey", has_open_text=True):
        from crystalos.crystal.context import CrystalContext
        return CrystalContext(
            org_id="org-1",
            user_id="user-1",
            survey_id="survey-1",
            scope=scope,
            has_open_text=has_open_text,
        )

    def test_contains_available_tools(self):
        """Prompt contains data tools and (for survey scope) action tools."""
        from crystalos.agents.crystal import _build_system_prompt_agentic

        prompt = _build_system_prompt_agentic(self._make_ctx())
        # Prompt now uses "Data Tools" + "Analytical Tools" + "Action Tools" sections
        assert "Data Tools" in prompt
        assert "Analytical Tools" in prompt
        assert "get_survey_overview" in prompt
        assert "analyze_key_drivers" in prompt  # analytical tools listed
        assert "recommend_next_actions" in prompt  # action tools included in survey scope

    def test_no_open_text_mentions_score_only(self):
        """When has_open_text=False, prompt says 'no open-text questions'."""
        from crystalos.agents.crystal import _build_system_prompt_agentic

        prompt = _build_system_prompt_agentic(self._make_ctx(has_open_text=False))
        assert "no open-text questions" in prompt.lower() or "no open-text" in prompt

    def test_org_scope_contains_portfolio_framing(self):
        """When scope is 'org', prompt includes portfolio-level framing."""
        from crystalos.agents.crystal import _build_system_prompt_agentic

        prompt = _build_system_prompt_agentic(self._make_ctx(scope="org"))
        # Should mention cross-survey or portfolio or "all surveys"
        lower = prompt.lower()
        assert "all surveys" in lower or "portfolio" in lower or "organization" in lower


# ── New imports at module level are added to the top of the file ─────────────
# (The additions below require: ActionProposal, _normalize_skill_output,
#  _skill_synthesis, _run_skill_loop, _run_skill_stream, _fetch_skill_context,
#  SkillResult — all already imported at the top of this file.)


# ── TestNormalizeSkillOutput ──────────────────────────────────────────────────

class TestNormalizeSkillOutput:
    """Tests for _normalize_skill_output(output, skill_name) -> CrystalOutput | None."""

    def test_crystal_analyst_shape(self):
        """crystal-analyst output shape maps to CrystalOutput fields exactly."""
        output = {
            "answer": "NPS has declined by 8 points due to onboarding friction.",
            "citations": ["ins-001", "ins-002"],
            "suggestions": ["What is the biggest pain point?", "How does this compare last quarter?"],
            "insight_refs": ["ins-001"],
        }
        result = _normalize_skill_output(output, "crystal-analyst")
        assert result is not None
        assert result.answer == output["answer"]
        assert result.citations == ["ins-001", "ins-002"]
        assert result.suggestions == ["What is the biggest pain point?", "How does this compare last quarter?"]
        assert result.insight_refs == ["ins-001"]

    def test_merges_insight_refs_into_citations(self):
        from uuid import uuid4
        uid = uuid4()
        output = {
            "answer": "NPS declined due to onboarding friction in recent verbatims.",
            "citations": [],
            "insight_refs": [uid],
            "suggestions": [],
        }
        result = _normalize_skill_output(output, "crystal-analyst")
        assert result is not None
        assert result.citations == [str(uid)]
        assert result.insight_refs == [str(uid)]

    def test_data_explorer_shape(self):
        """data-explorer output: summary → answer, suggested_lenses → suggestions."""
        output = {
            "summary": "Response volume is highest in the APAC region with 45% of total responses.",
            "themes": ["Onboarding", "Support", "Pricing"],
            "suggested_lenses": ["Break down by region", "Filter by NPS segment", "Look at trend over time"],
        }
        result = _normalize_skill_output(output, "data-explorer")
        assert result is not None
        assert result.answer.startswith("Response volume is highest")
        assert "Break down by region" in result.suggestions

    def test_trend_analyst_shape(self):
        """trend-analyst output: headline → answer base, trend_findings appended as bullets."""
        output = {
            "headline": "NPS has improved significantly over Q3.",
            "trend_findings": [
                {"finding": "NPS rose 8pts between June and September"},
                {"finding": "Q3 inflection driven by improved onboarding"},
            ],
        }
        result = _normalize_skill_output(output, "trend-analyst")
        assert result is not None
        assert result.answer.startswith("NPS has improved significantly")
        assert "NPS rose 8pts" in result.answer
        assert "Q3 inflection" in result.answer

    def test_action_recommender_shape(self):
        """action-recommender: recommendation → answer, action_proposals coerced to ActionProposal."""
        output = {
            "recommendation": "Create a follow-up survey targeting NPS detractors.",
            "action_proposals": [
                {
                    "id": "a1",
                    "type": "create_survey",
                    "title": "Create followup survey",
                    "description": "Reach detractors to understand root causes",
                    "params": {},
                }
            ],
        }
        result = _normalize_skill_output(output, "action-recommender")
        assert result is not None
        assert result.answer == "Create a follow-up survey targeting NPS detractors."
        assert len(result.action_proposals) == 1
        ap = result.action_proposals[0]
        assert isinstance(ap, ActionProposal)
        assert ap.id == "a1"
        assert ap.type == "create_survey"
        assert ap.title == "Create followup survey"

    def test_skill_proposals_without_id_are_normalised(self):
        """A skill (e.g. crystal-analyst) may emit proposals that omit id or use
        proposal_type — these must still surface, with id/type filled in."""
        output = {
            "answer": "NPS is 28 — below target. Detractors cite onboarding friction repeatedly.",
            "action_proposals": [
                {"type": "create_alert", "title": "Alert on NPS below 30",
                 "description": "Notify the team if NPS keeps falling",
                 "params": {"alert_type": "S-03", "threshold_config": {"below": 30}}},
                {"proposal_type": "workflow", "title": "Notify CSM on detractors",
                 "description": "Route every detractor to a CSM", "params": {}},
            ],
        }
        result = _normalize_skill_output(output, "crystal-analyst")
        assert result is not None
        assert len(result.action_proposals) == 2
        a0, a1 = result.action_proposals
        assert a0.type == "create_alert" and a0.id          # id auto-filled
        assert a1.type == "create_workflow"                  # proposal_type alias mapped
        assert a1.id

    def test_missing_answer_returns_none(self):
        """Output with no recognisable answer field returns None."""
        output = {
            "some_other_field": "foo",
            "metadata": {"version": "1.0"},
        }
        result = _normalize_skill_output(output, "crystal-analyst")
        assert result is None

    def test_too_short_answer_returns_none(self):
        """Output with an answer shorter than 20 characters returns None."""
        output = {"answer": "Short"}  # only 5 characters
        result = _normalize_skill_output(output, "crystal-analyst")
        assert result is None

    def test_suggestions_capped_at_three(self):
        """Only the first 3 suggestions are kept even if more are provided."""
        output = {
            "answer": "Shipping delays are the primary driver of low NPS scores across all regions.",
            "suggestions": [
                "Which regions are worst?",
                "How does this compare to Q2?",
                "What actions can we take?",
                "Can we segment by NPS group?",
                "What does the trend look like?",
            ],
        }
        result = _normalize_skill_output(output, "crystal-analyst")
        assert result is not None
        assert len(result.suggestions) == 3

    def test_navigation_dict_suggestions_coerced(self):
        """Regression: dict navigation items in skill suggestions map to label strings."""
        output = {
            "answer": "Detractors cite slow support as the primary driver of low NPS this quarter.",
            "suggestions": [
                {"type": "navigation", "route": "/app/insights", "label": "View Detractor sentiment"},
                "What is driving detractors?",
            ],
        }
        result = _normalize_skill_output(output, "crystal-analyst")
        assert result is not None
        assert result.suggestions == ["View Detractor sentiment", "What is driving detractors?"]

    def test_specialist_headline_narrative_combined(self):
        """Short headline + narrative combines into a usable Crystal answer."""
        output = {
            "headline": "NPS is volatile.",
            "narrative": "Scores swung between 38 and 52 over the last two quarters with no clear trend.",
        }
        result = _normalize_skill_output(output, "specialist-nps")
        assert result is not None
        assert "NPS is volatile." in result.answer
        assert "last two quarters" in result.answer

    def test_invalid_action_proposal_skipped(self):
        """Action proposals missing required fields are skipped; valid ones are kept."""
        output = {
            "answer": "Recommend creating a follow-up survey to understand detractor sentiment.",
            "action_proposals": [
                {"id": "a1", "type": "create_survey", "title": "Create followup", "description": "Reach detractors"},
                {"type": "create_survey"},  # missing id, title, description — invalid
            ],
        }
        result = _normalize_skill_output(output, "action-recommender")
        assert result is not None
        # The valid proposal is kept; the invalid one is skipped
        assert len(result.action_proposals) == 1
        assert result.action_proposals[0].id == "a1"


class TestResolveCrystalSkillMatch:
    """Crystal chat routing skips action-advisor sub-specialists."""

    @pytest.mark.asyncio
    async def test_skips_action_advisor_for_next_match(self):
        from crystalos.lib.skill_registry import SkillRegistry

        registry = SkillRegistry()
        registry._skills = {
            "nps-action-advisor": {
                "name": "nps-action-advisor",
                "description": "NPS actions",
            },
            "crystal-analyst": {
                "name": "crystal-analyst",
                "description": "Crystal analyst",
            },
        }

        async def fake_find(query, top_k=5):
            return [
                (registry._skills["nps-action-advisor"], 0.9),
                (registry._skills["crystal-analyst"], 0.7),
            ]

        registry.find = fake_find  # type: ignore[method-assign]

        meta, score = await _resolve_crystal_skill_match(registry, "what should I do about NPS")
        assert meta is not None
        assert meta["name"] == "crystal-analyst"
        assert score == 0.7


# ── TestSkillSynthesis ────────────────────────────────────────────────────────

class TestSkillSynthesis:
    """Tests for _skill_synthesis(inp, tool_results) -> CrystalOutput | None."""

    def _make_inp(self, **kwargs):
        defaults = dict(
            survey_id="s1",
            org_id="org1",
            message="What are the top issues with our product?",
            insights=[],
            topics=[],
            metrics={},
        )
        defaults.update(kwargs)
        return CrystalInput(**defaults)

    def _make_skill_meta(self, name="crystal-analyst"):
        return {
            "name": name,
            "version": "1.0.0",
            "description": "Answers analytical questions about survey data",
            "allowed_tools": ["get_survey_overview", "get_insights_list"],
            "_body": "You are a crystal analyst skill.",
            "_dir": "/tmp",
            "evals": "EVALS.md",
            "max_output_tokens": 2000,
            "max_retries": 1,
            "timeout_seconds": 60,
        }

    def _make_skill_result(self, output, eval_passed=True):
        return SkillResult(
            output=output,
            eval_score=0.85 if eval_passed else 0.40,
            eval_passed=eval_passed,
            eval_issues=[] if eval_passed else ["quality below threshold"],
            retried=False,
            skill_name="crystal-analyst",
            skill_version="1.0.0",
            model="test-model",
            tokens_used=100,
            latency_ms=500.0,
        )

    @pytest.mark.asyncio
    async def test_routes_to_best_skill(self):
        """Registry returns crystal-analyst skill and runtime returns valid output → CrystalOutput."""
        skill_meta = self._make_skill_meta()
        skill_output = {
            "answer": "The top issues are shipping delays and poor onboarding experience.",
            "citations": [],
            "suggestions": ["How can we fix shipping?"],
            "insight_refs": [],
        }
        skill_result = self._make_skill_result(skill_output)

        mock_registry = MagicMock()
        mock_registry._initialized = True
        mock_registry._skills = {"crystal-analyst": skill_meta}
        mock_registry.find = AsyncMock(return_value=[(skill_meta, 0.85)])
        mock_registry.find_sync = MagicMock(return_value=None)

        mock_runtime = AsyncMock()
        mock_runtime.execute = AsyncMock(return_value=skill_result)

        with (
            patch("crystalos.lib.skill_registry.get_registry", return_value=mock_registry),
            patch("crystalos.lib.skill_runtime.SkillRuntime", return_value=mock_runtime),
        ):
            result = await _skill_synthesis(self._make_inp(), [])

        assert result is not None
        assert isinstance(result, CrystalOutput)
        assert "shipping" in result.answer.lower()

    @pytest.mark.asyncio
    async def test_returns_none_when_no_skill_found(self):
        """Registry find returns [] and find_sync returns None → returns None."""
        mock_registry = MagicMock()
        mock_registry._initialized = True
        mock_registry._skills = {}
        mock_registry.find = AsyncMock(return_value=[])
        mock_registry.find_sync = MagicMock(return_value=None)

        with patch("crystalos.lib.skill_registry.get_registry", return_value=mock_registry):
            result = await _skill_synthesis(self._make_inp(), [])

        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_on_eval_failure(self):
        """Skill result with eval_passed=False returns None and logs a warning."""
        skill_meta = self._make_skill_meta()
        skill_result = self._make_skill_result(
            {"answer": "Some mediocre answer that is long enough to pass length check"},
            eval_passed=False,
        )

        mock_registry = MagicMock()
        mock_registry._initialized = True
        mock_registry._skills = {"crystal-analyst": skill_meta}
        mock_registry.find = AsyncMock(return_value=[(skill_meta, 0.80)])
        mock_registry.find_sync = MagicMock(return_value=None)

        mock_runtime = AsyncMock()
        mock_runtime.execute = AsyncMock(return_value=skill_result)

        with (
            patch("crystalos.lib.skill_registry.get_registry", return_value=mock_registry),
            patch("crystalos.lib.skill_runtime.SkillRuntime", return_value=mock_runtime),
        ):
            result = await _skill_synthesis(self._make_inp(), [])

        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_on_exception(self):
        """If get_registry raises an exception, returns None (no propagation)."""
        with patch(
            "crystalos.lib.skill_registry.get_registry",
            side_effect=Exception("Registry unavailable"),
        ):
            result = await _skill_synthesis(self._make_inp(), [])

        assert result is None

    @pytest.mark.asyncio
    async def test_skill_input_includes_survey_facts(self):
        """The input_data passed to runtime.execute contains survey_facts with survey_id and nps_score."""
        skill_meta = self._make_skill_meta()
        skill_output = {
            "answer": "Your NPS score of 42 is above the industry median of 35 for SaaS companies.",
            "citations": [],
            "suggestions": [],
            "insight_refs": [],
        }
        skill_result = self._make_skill_result(skill_output)

        captured_input = {}

        async def capture_execute(skill_name, meta, input_data, ctx):
            captured_input.update(input_data)
            return skill_result

        mock_runtime = AsyncMock()
        mock_runtime.execute = capture_execute

        mock_registry = MagicMock()
        mock_registry._initialized = True
        mock_registry._skills = {"crystal-analyst": skill_meta}
        mock_registry.find = AsyncMock(return_value=[(skill_meta, 0.85)])
        mock_registry.find_sync = MagicMock(return_value=None)

        inp = self._make_inp(
            survey_id="survey-xyz",
            metrics={"nps": {"score": 42, "n": 200}},
        )

        with (
            patch("crystalos.lib.skill_registry.get_registry", return_value=mock_registry),
            patch("crystalos.lib.skill_runtime.SkillRuntime", return_value=mock_runtime),
        ):
            await _skill_synthesis(inp, [])

        assert "survey_facts" in captured_input
        assert captured_input["survey_facts"]["survey_id"] == "survey-xyz"
        assert captured_input["survey_facts"]["nps_score"] == 42
        assert "message" in captured_input

    @pytest.mark.asyncio
    async def test_skill_input_stringifies_uuid_insight_ids(self):
        """Insight IDs from asyncpg may be UUID objects — skill input must stringify them."""
        from uuid import uuid4

        skill_meta = self._make_skill_meta()
        insight_id = uuid4()
        skill_result = self._make_skill_result({
            "answer": "Shipping delays are the dominant detractor theme in your latest responses.",
            "citations": [],
            "suggestions": [],
            "insight_refs": [],
        })

        captured_input = {}

        async def capture_execute(skill_name, meta, input_data, ctx):
            captured_input.update(input_data)
            return skill_result

        mock_runtime = AsyncMock()
        mock_runtime.execute = capture_execute

        mock_registry = MagicMock()
        mock_registry._initialized = True
        mock_registry._skills = {"crystal-analyst": skill_meta}
        mock_registry.find = AsyncMock(return_value=[(skill_meta, 0.85)])
        mock_registry.find_sync = MagicMock(return_value=None)

        inp = self._make_inp(
            survey_id=str(uuid4()),
            insights=[{"id": insight_id, "headline": "Shipping delays", "layer": "diagnostic"}],
        )

        with (
            patch("crystalos.lib.skill_registry.get_registry", return_value=mock_registry),
            patch("crystalos.lib.skill_runtime.SkillRuntime", return_value=mock_runtime),
        ):
            await _skill_synthesis(inp, [])

        assert captured_input["insights"][0]["id"] == str(insight_id)
        assert isinstance(captured_input["survey_facts"]["survey_id"], str)

    @pytest.mark.asyncio
    async def test_tool_results_included_in_skill_input(self):
        """Tool results passed to _skill_synthesis are forwarded in skill_input['tool_results']."""
        skill_meta = self._make_skill_meta()
        skill_output = {
            "answer": "Based on 100 responses, the top theme is onboarding friction with high urgency.",
            "citations": [],
            "suggestions": [],
            "insight_refs": [],
        }
        skill_result = self._make_skill_result(skill_output)

        captured_input = {}

        async def capture_execute(skill_name, meta, input_data, ctx):
            captured_input.update(input_data)
            return skill_result

        mock_runtime = AsyncMock()
        mock_runtime.execute = capture_execute

        mock_registry = MagicMock()
        mock_registry._initialized = True
        mock_registry._skills = {"crystal-analyst": skill_meta}
        mock_registry.find = AsyncMock(return_value=[(skill_meta, 0.85)])
        mock_registry.find_sync = MagicMock(return_value=None)

        tool_results = [
            {"tool": "get_survey_overview", "args": {}, "result": {"response_count": 100}},
        ]

        with (
            patch("crystalos.lib.skill_registry.get_registry", return_value=mock_registry),
            patch("crystalos.lib.skill_runtime.SkillRuntime", return_value=mock_runtime),
        ):
            await _skill_synthesis(self._make_inp(), tool_results)

        assert "tool_results" in captured_input
        assert "get_survey_overview" in captured_input["tool_results"]

    @pytest.mark.asyncio
    async def test_difflib_fallback_used(self):
        """When registry.find returns [], find_sync fallback returns skill name and it is used."""
        skill_meta = self._make_skill_meta(name="data-explorer")
        skill_output = {
            "summary": "APAC region has the highest response volume at 45% of total responses.",
            "themes": [],
            "suggested_lenses": ["Break by region"],
        }
        skill_result = self._make_skill_result(skill_output)

        mock_runtime = AsyncMock()
        mock_runtime.execute = AsyncMock(return_value=skill_result)

        mock_registry = MagicMock()
        mock_registry._initialized = True
        mock_registry._skills = {"data-explorer": skill_meta}
        mock_registry.find = AsyncMock(return_value=[])
        mock_registry.find_sync = MagicMock(return_value="data-explorer")

        with (
            patch("crystalos.lib.skill_registry.get_registry", return_value=mock_registry),
            patch("crystalos.lib.skill_runtime.SkillRuntime", return_value=mock_runtime),
        ):
            result = await _skill_synthesis(self._make_inp(), [])

        assert result is not None
        assert "APAC" in result.answer


# ── TestRunSkillLoop ──────────────────────────────────────────────────────────

class TestRunSkillLoop:
    """Tests for _run_skill_loop(inp) -> CrystalOutput."""

    def _make_inp(self, **kwargs):
        defaults = dict(
            survey_id="s1",
            org_id="org1",
            message="What are the top issues?",
            insights=[],
            topics=[],
            metrics={},
        )
        defaults.update(kwargs)
        return CrystalInput(**defaults)

    def _make_skill_result(self, output, eval_passed=True):
        return SkillResult(
            output=output,
            eval_score=0.85 if eval_passed else 0.40,
            eval_passed=eval_passed,
            eval_issues=[],
            retried=False,
            skill_name="crystal-analyst",
            skill_version="1.0.0",
            model="test-model",
            tokens_used=100,
            latency_ms=500.0,
        )

    @pytest.mark.asyncio
    async def test_returns_skill_output_when_skill_succeeds(self):
        """When _skill_synthesis returns a valid CrystalOutput, it is returned directly."""
        expected = CrystalOutput(
            answer="Onboarding friction is the main driver of low NPS scores across all cohorts.",
            citations=["ins-001"],
            suggestions=["How does this compare to Q2?"],
        )

        with (
            patch("crystalos.agents.crystal._crystal_rate_count", new=AsyncMock(return_value=0)),
            patch("crystalos.agents.crystal._skill_synthesis", new=AsyncMock(return_value=expected)),
            patch("crystalos.crystal.tools.dispatch_tool", new=AsyncMock(return_value={"data": "ok"})),
        ):
            result = await _run_skill_loop(self._make_inp())

        assert result is expected
        assert result.answer == expected.answer

    @pytest.mark.asyncio
    async def test_falls_back_to_run_crystal_when_skill_fails(self):
        """When _skill_synthesis returns None, _run_crystal is called as fallback."""
        fallback = CrystalOutput(
            answer="Shipping delays are the primary driver of negative sentiment among detractors.",
            citations=[],
            suggestions=[],
        )

        with (
            patch("crystalos.agents.crystal._crystal_rate_count", new=AsyncMock(return_value=0)),
            patch("crystalos.agents.crystal._skill_synthesis", new=AsyncMock(return_value=None)),
            patch("crystalos.agents.crystal._run_crystal", new=AsyncMock(return_value=fallback)),
            patch("crystalos.crystal.tools.dispatch_tool", new=AsyncMock(return_value={"data": "ok"})),
        ):
            result = await _run_skill_loop(self._make_inp())

        assert result is fallback

    @pytest.mark.asyncio
    async def test_rate_limit_raises(self):
        """When _crystal_rate_count returns 11, raises ValueError('Rate limit exceeded')."""
        with patch("crystalos.agents.crystal._crystal_rate_count", new=AsyncMock(return_value=11)):
            with pytest.raises(ValueError, match="Rate limit"):
                await _run_skill_loop(self._make_inp())

    @pytest.mark.asyncio
    async def test_prefetches_tool_context(self):
        """_fetch_skill_context is called with the skill_meta dict found by the registry."""
        skill_meta = {
            "name": "crystal-analyst",
            "description": "Analytical skill",
            "allowed_tools": ["get_survey_overview"],
            "_body": "",
            "_dir": "/tmp",
            "version": "1.0.0",
            "evals": "EVALS.md",
            "max_output_tokens": 2000,
            "max_retries": 1,
            "timeout_seconds": 60,
        }

        mock_registry = MagicMock()
        mock_registry._initialized = True
        mock_registry._skills = {"crystal-analyst": skill_meta}
        mock_registry.find = AsyncMock(return_value=[(skill_meta, 0.85)])
        mock_registry.find_sync = MagicMock(return_value=None)

        mock_fetch = AsyncMock(return_value=[])
        expected_output = CrystalOutput(
            answer="The primary driver of low NPS is shipping delays affecting the APAC region.",
            citations=[],
            suggestions=[],
        )

        with (
            patch("crystalos.agents.crystal._crystal_rate_count", new=AsyncMock(return_value=0)),
            patch("crystalos.lib.skill_registry.get_registry", return_value=mock_registry),
            patch("crystalos.agents.crystal._fetch_skill_context", new=mock_fetch),
            patch("crystalos.agents.crystal._skill_synthesis", new=AsyncMock(return_value=expected_output)),
        ):
            await _run_skill_loop(self._make_inp())

        assert mock_fetch.called
        call_kwargs = mock_fetch.call_args
        # The second argument should be a dict with a "name" key (skill_meta)
        passed_meta = call_kwargs[0][1]
        assert isinstance(passed_meta, dict)
        assert "name" in passed_meta

    @pytest.mark.asyncio
    async def test_tool_results_passed_to_skill_synthesis(self):
        """Tool results returned by _fetch_skill_context are forwarded to _skill_synthesis."""
        skill_meta = {
            "name": "crystal-analyst",
            "description": "Analytical skill",
            "allowed_tools": ["get_survey_overview"],
            "_body": "",
            "_dir": "/tmp",
            "version": "1.0.0",
            "evals": "EVALS.md",
            "max_output_tokens": 2000,
            "max_retries": 1,
            "timeout_seconds": 60,
        }

        fetched_tools = [{"tool": "get_survey_overview", "args": {}, "result": {"response_count": 500}}]

        mock_registry = MagicMock()
        mock_registry._initialized = True
        mock_registry._skills = {"crystal-analyst": skill_meta}
        mock_registry.find = AsyncMock(return_value=[(skill_meta, 0.85)])
        mock_registry.find_sync = MagicMock(return_value=None)

        captured_tool_results = {}

        async def fake_skill_synthesis(inp, tool_results, skill_meta=None, score=None):
            captured_tool_results["results"] = tool_results
            captured_tool_results["skill_meta"] = skill_meta
            return CrystalOutput(
                answer="Based on 500 responses, the top issue is onboarding friction requiring immediate action.",
                citations=[],
                suggestions=[],
            )

        with (
            patch("crystalos.agents.crystal._crystal_rate_count", new=AsyncMock(return_value=0)),
            patch("crystalos.lib.skill_registry.get_registry", return_value=mock_registry),
            patch("crystalos.agents.crystal._fetch_skill_context", new=AsyncMock(return_value=fetched_tools)),
            patch("crystalos.agents.crystal._skill_synthesis", new=fake_skill_synthesis),
        ):
            await _run_skill_loop(self._make_inp())

        assert captured_tool_results["results"] == fetched_tools
        # Fix #3: the skill resolved during prefetch is reused by synthesis
        # (passed through) rather than re-routed a second time.
        assert captured_tool_results["skill_meta"] == skill_meta


# ── TestRunSkillStream ────────────────────────────────────────────────────────

class TestRunSkillStream:
    """Tests for _run_skill_stream(inp, ...) — async generator yielding JSON SSE strings."""

    def _make_inp(self, **kwargs):
        defaults = dict(
            survey_id="s1",
            org_id="org1",
            message="What are the top issues?",
            insights=[],
            topics=[],
            metrics={},
        )
        defaults.update(kwargs)
        return CrystalInput(**defaults)

    async def _collect(self, gen) -> list[dict]:
        events = []
        async for line in gen:
            events.append(json.loads(line))
        return events

    def _make_skill_output(self, answer="Onboarding friction is the primary driver of low NPS."):
        return CrystalOutput(
            answer=answer,
            citations=["ins-001"],
            suggestions=["How does this compare to Q2?", "What actions can we take?"],
        )

    @pytest.mark.asyncio
    async def test_emits_thinking_and_synthesizing_events(self):
        """Stream emits 'thinking' and 'synthesizing' event types during normal flow."""
        skill_meta = {
            "name": "crystal-analyst",
            "description": "Analytical skill",
            "allowed_tools": ["get_survey_overview"],
            "_body": "",
            "_dir": "/tmp",
            "version": "1.0.0",
            "evals": "EVALS.md",
            "max_output_tokens": 2000,
            "max_retries": 1,
            "timeout_seconds": 60,
        }

        mock_registry = MagicMock()
        mock_registry._initialized = True
        mock_registry._skills = {"crystal-analyst": skill_meta}
        mock_registry.find = AsyncMock(return_value=[(skill_meta, 0.85)])
        mock_registry.find_sync = MagicMock(return_value=None)

        skill_out = self._make_skill_output()

        with (
            patch("crystalos.agents.crystal._crystal_rate_count", new=AsyncMock(return_value=0)),
            patch("crystalos.lib.skill_registry.get_registry", return_value=mock_registry),
            patch("crystalos.crystal.tools.dispatch_tool", new=AsyncMock(return_value={"response_count": 100})),
            patch("crystalos.agents.crystal._skill_synthesis", new=AsyncMock(return_value=skill_out)),
        ):
            events = await self._collect(_run_skill_stream(self._make_inp()))

        types = [e["type"] for e in events]
        assert "thinking" in types
        assert "synthesizing" in types

    @pytest.mark.asyncio
    async def test_emits_answer_event(self):
        """Stream emits a final 'answer' event with correct answer, citations, suggestions."""
        skill_out = self._make_skill_output()

        mock_registry = MagicMock()
        mock_registry._initialized = True
        mock_registry._skills = {}
        mock_registry.find = AsyncMock(return_value=[])
        mock_registry.find_sync = MagicMock(return_value=None)

        with (
            patch("crystalos.agents.crystal._crystal_rate_count", new=AsyncMock(return_value=0)),
            patch("crystalos.lib.skill_registry.get_registry", return_value=mock_registry),
            patch("crystalos.agents.crystal._skill_synthesis", new=AsyncMock(return_value=skill_out)),
        ):
            events = await self._collect(_run_skill_stream(self._make_inp()))

        answer_events = [e for e in events if e.get("type") == "answer"]
        assert len(answer_events) == 1
        ae = answer_events[0]
        assert ae["answer"] == skill_out.answer
        assert ae["citations"] == skill_out.citations
        assert ae["suggestions"] == skill_out.suggestions

    @pytest.mark.asyncio
    async def test_emits_action_proposals_event(self):
        """Stream emits 'action_proposals' event before 'answer' when skill returns proposals."""
        proposal = ActionProposal(
            id="p1",
            type="create_survey",
            title="Create followup survey",
            description="Reach detractors to understand root causes of NPS decline",
        )
        skill_out = CrystalOutput(
            answer="We recommend creating a follow-up survey to capture detractor sentiment at scale.",
            citations=[],
            suggestions=[],
            action_proposals=[proposal],
        )

        mock_registry = MagicMock()
        mock_registry._initialized = True
        mock_registry._skills = {}
        mock_registry.find = AsyncMock(return_value=[])
        mock_registry.find_sync = MagicMock(return_value=None)

        with (
            patch("crystalos.agents.crystal._crystal_rate_count", new=AsyncMock(return_value=0)),
            patch("crystalos.lib.skill_registry.get_registry", return_value=mock_registry),
            patch("crystalos.agents.crystal._skill_synthesis", new=AsyncMock(return_value=skill_out)),
        ):
            events = await self._collect(_run_skill_stream(self._make_inp()))

        types = [e["type"] for e in events]
        assert "action_proposals" in types
        assert "answer" in types
        # action_proposals must come before answer
        assert types.index("action_proposals") < types.index("answer")

    @pytest.mark.asyncio
    async def test_falls_back_to_run_crystal_on_skill_failure(self):
        """When _skill_synthesis returns None, stream uses _run_crystal answer."""
        fallback = CrystalOutput(
            answer="Shipping delays drive 38% of detractor sentiment in the APAC region.",
            citations=["ins-002"],
            suggestions=["Which regions are worst affected?"],
        )

        mock_registry = MagicMock()
        mock_registry._initialized = True
        mock_registry._skills = {}
        mock_registry.find = AsyncMock(return_value=[])
        mock_registry.find_sync = MagicMock(return_value=None)

        with (
            patch("crystalos.agents.crystal._crystal_rate_count", new=AsyncMock(return_value=0)),
            patch("crystalos.lib.skill_registry.get_registry", return_value=mock_registry),
            patch("crystalos.agents.crystal._skill_synthesis", new=AsyncMock(return_value=None)),
            patch("crystalos.agents.crystal._run_crystal", new=AsyncMock(return_value=fallback)),
        ):
            events = await self._collect(_run_skill_stream(self._make_inp()))

        answer_events = [e for e in events if e.get("type") == "answer"]
        assert len(answer_events) == 1
        assert answer_events[0]["answer"] == fallback.answer

    @pytest.mark.asyncio
    async def test_rate_limit_emits_error_event(self):
        """When rate limit count > 10, stream yields a single 'error' event."""
        with patch("crystalos.agents.crystal._crystal_rate_count", new=AsyncMock(return_value=11)):
            events = await self._collect(_run_skill_stream(self._make_inp()))

        assert len(events) >= 1
        assert events[0]["type"] == "error"
        assert "rate" in events[0]["message"].lower() or "limit" in events[0]["message"].lower()

    @pytest.mark.asyncio
    async def test_emits_observation_events_for_tools(self):
        """When dispatch_tool returns a valid result, stream emits 'observation' events."""
        skill_meta = {
            "name": "crystal-analyst",
            "description": "Analytical skill",
            "allowed_tools": ["get_survey_overview"],
            "_body": "",
            "_dir": "/tmp",
            "version": "1.0.0",
            "evals": "EVALS.md",
            "max_output_tokens": 2000,
            "max_retries": 1,
            "timeout_seconds": 60,
        }

        mock_registry = MagicMock()
        mock_registry._initialized = True
        mock_registry._skills = {"crystal-analyst": skill_meta}
        mock_registry.find = AsyncMock(return_value=[(skill_meta, 0.85)])
        mock_registry.find_sync = MagicMock(return_value=None)

        skill_out = self._make_skill_output()

        with (
            patch("crystalos.agents.crystal._crystal_rate_count", new=AsyncMock(return_value=0)),
            patch("crystalos.lib.skill_registry.get_registry", return_value=mock_registry),
            patch("crystalos.crystal.tools.dispatch_tool", new=AsyncMock(return_value={"response_count": 250})),
            patch("crystalos.agents.crystal._skill_synthesis", new=AsyncMock(return_value=skill_out)),
        ):
            events = await self._collect(_run_skill_stream(self._make_inp()))

        observation_events = [e for e in events if e.get("type") == "observation"]
        assert len(observation_events) >= 1

    @pytest.mark.asyncio
    async def test_debug_flag_emits_routing_event(self):
        """When debug=True and a skill is found, first event is 'debug_routing' with skill name."""
        skill_meta = {
            "name": "crystal-analyst",
            "description": "Analytical skill",
            "allowed_tools": ["get_survey_overview"],
            "_body": "",
            "_dir": "/tmp",
            "version": "1.0.0",
            "evals": "EVALS.md",
            "max_output_tokens": 2000,
            "max_retries": 1,
            "timeout_seconds": 60,
        }

        mock_registry = MagicMock()
        mock_registry._initialized = True
        mock_registry._skills = {"crystal-analyst": skill_meta}
        mock_registry.find = AsyncMock(return_value=[(skill_meta, 0.85)])
        mock_registry.find_sync = MagicMock(return_value=None)

        skill_out = self._make_skill_output()

        with (
            patch("crystalos.agents.crystal._crystal_rate_count", new=AsyncMock(return_value=0)),
            patch("crystalos.lib.skill_registry.get_registry", return_value=mock_registry),
            patch("crystalos.crystal.tools.dispatch_tool", new=AsyncMock(return_value={"response_count": 100})),
            patch("crystalos.agents.crystal._skill_synthesis", new=AsyncMock(return_value=skill_out)),
        ):
            events = await self._collect(_run_skill_stream(self._make_inp(), debug=True))

        routing_events = [e for e in events if e.get("type") == "debug_routing"]
        assert len(routing_events) >= 1
        assert routing_events[0].get("skill") == "crystal-analyst"


# ── TestActionProposalTypes ───────────────────────────────────────────────────

class TestActionProposalTypes:
    """Tests that ActionProposal covers all navigation-relevant types used by the frontend."""

    def test_create_survey_type(self):
        """create_survey type validates and serializes to dict with all required fields."""
        ap = ActionProposal(
            id="a1",
            type="create_survey",
            title="Create followup survey for detractors",
            description="Reach NPS detractors to understand root causes of dissatisfaction",
            params={"intent": "Follow up with detractors"},
        )
        data = ap.model_dump()
        assert data["id"] == "a1"
        assert data["type"] == "create_survey"
        assert data["title"] == "Create followup survey for detractors"
        assert data["description"] == "Reach NPS detractors to understand root causes of dissatisfaction"
        assert data["params"] == {"intent": "Follow up with detractors"}
        assert "cta_label" in data
        assert "requires_confirmation" in data

    def test_edit_survey_type(self):
        """edit_survey type with params serializes correctly."""
        ap = ActionProposal(
            id="a2",
            type="edit_survey",
            title="Add NPS follow-up question",
            description="Adding a follow-up question will improve diagnostic power of detractor responses",
            params={"message": "Add NPS question after Q3"},
        )
        data = ap.model_dump()
        assert data["type"] == "edit_survey"
        assert data["params"]["message"] == "Add NPS question after Q3"

    def test_distribute_type(self):
        """distribute type serializes correctly with defaults."""
        ap = ActionProposal(
            id="a3",
            type="distribute",
            title="Send survey to APAC segment",
            description="Target the APAC customer segment to boost response rate in underrepresented region",
        )
        data = ap.model_dump()
        assert data["type"] == "distribute"
        assert data["id"] == "a3"
        assert data["params"] == {}  # default empty dict

    def test_create_workflow_type(self):
        """create_workflow type with trigger and action_type params serializes correctly."""
        ap = ActionProposal(
            id="a4",
            type="create_workflow",
            title="Alert team when NPS drops below 30",
            description="Automated alert to CX team when NPS score drops below threshold",
            params={"trigger": "nps_below_6", "action_type": "notify"},
        )
        data = ap.model_dump()
        assert data["type"] == "create_workflow"
        assert data["params"]["trigger"] == "nps_below_6"
        assert data["params"]["action_type"] == "notify"

    def test_view_template_type(self):
        """view_template type serializes correctly and cta_label defaults to 'Apply'."""
        ap = ActionProposal(
            id="a5",
            type="view_template",
            title="Apply NPS Detractor Recovery template",
            description="This template is pre-configured for detractor recovery surveys",
        )
        data = ap.model_dump()
        assert data["type"] == "view_template"
        assert data["cta_label"] == "Apply"

    def test_action_proposal_requires_confirmation_by_default(self):
        """requires_confirmation defaults to True — Crystal never executes autonomously."""
        ap = ActionProposal(
            id="a6",
            type="create_survey",
            title="Create customer pulse survey",
            description="A lightweight monthly pulse survey to track NPS trend continuously",
        )
        assert ap.requires_confirmation is True

    def test_action_proposal_in_crystal_output(self):
        """CrystalOutput with action_proposals round-trips through model_dump() and back."""
        proposal = ActionProposal(
            id="p1",
            type="create_survey",
            title="Create detractor follow-up survey",
            description="Reach out to detractors with targeted questions to understand root causes",
            params={"intent": "detractor_recovery"},
            priority="high",
        )
        out = CrystalOutput(
            answer="We recommend creating a follow-up survey to capture detailed detractor feedback.",
            citations=["ins-001"],
            suggestions=["How many detractors are there?"],
            action_proposals=[proposal],
        )
        dumped = out.model_dump()
        assert len(dumped["action_proposals"]) == 1
        ap_data = dumped["action_proposals"][0]
        assert ap_data["id"] == "p1"
        assert ap_data["type"] == "create_survey"
        assert ap_data["priority"] == "high"
        assert ap_data["requires_confirmation"] is True
        # Reconstruct from dump
        restored = CrystalOutput(**dumped)
        assert len(restored.action_proposals) == 1
        assert restored.action_proposals[0].id == "p1"


# ── Tag scope wiring (scope='tag' + tag_id → CrystalContext.tag_ids) ──────────

class TestTagScopeWiring:
    """CrystalContext.tag_ids existed but nothing populated/used it for scope='tag'
    requests until this change. Covers CrystalInput.tag_id -> _build_ctx ->
    CrystalContext.tag_ids, and the semantic-routing/tool-prefetch signal that
    consumes it."""

    def test_crystal_context_accepts_tag_scope(self):
        from crystalos.crystal.context import CrystalContext
        ctx = CrystalContext(org_id="org-1", user_id="u1", survey_id=None,
                              scope="tag", tag_ids=("tag-1",))
        assert ctx.scope == "tag"
        assert ctx.tag_ids == ("tag-1",)

    def test_build_ctx_populates_tag_ids_from_singular_tag_id(self):
        """Backend's scope='tag' request body sends `tag_id` (singular) — see
        backend/src/routes/experience.ts. _build_ctx must wrap it into tag_ids."""
        from crystalos.agents.crystal import _build_ctx
        inp = CrystalInput(survey_id="", org_id="org-1", message="how's this tag doing?",
                            insights=[], scope="tag", tag_id="tag-42")
        ctx = _build_ctx(inp)
        assert ctx.scope == "tag"
        assert ctx.tag_ids == ("tag-42",)

    def test_build_ctx_prefers_explicit_tag_ids_list(self):
        from crystalos.agents.crystal import _build_ctx
        inp = CrystalInput(survey_id="", org_id="org-1", message="msg", insights=[],
                            scope="group", tag_ids=["tag-a", "tag-b"], tag_id="tag-ignored")
        ctx = _build_ctx(inp)
        assert ctx.tag_ids == ("tag-a", "tag-b")

    def test_build_ctx_survey_scope_has_no_tag_ids(self):
        """Backward-compat: existing survey-scope callers (no tag_id/tag_ids at
        all) must still resolve tag_ids to None, unchanged."""
        from crystalos.agents.crystal import _build_ctx
        inp = CrystalInput(survey_id="s1", org_id="org-1", message="msg", insights=[])
        ctx = _build_ctx(inp)
        assert ctx.scope == "survey"
        assert ctx.tag_ids is None

    def test_get_tools_for_scope_tag_includes_group_tools(self):
        """A tag IS a survey group — tag scope must see get_group_* tools too,
        not just the tag-specific ones, since tag-analyst's allowed-tools spans both."""
        from crystalos.crystal.registry import get_tools_for_scope
        names = {t["name"] for t in get_tools_for_scope("tag")}
        assert "get_tag_report" in names
        assert "get_group_surveys" in names
        assert "get_group_metrics" in names
        assert "get_survey_overview" not in names  # survey-only tool stays excluded

    def test_routing_hint_added_for_tag_scope(self):
        from crystalos.agents.crystal import _routing_hint_for_scope
        from crystalos.crystal.context import CrystalContext
        tag_ctx = CrystalContext(org_id="o", user_id="u", survey_id=None, scope="tag", tag_ids=("t1",))
        survey_ctx = CrystalContext(org_id="o", user_id="u", survey_id="s1", scope="survey")
        assert _routing_hint_for_scope(tag_ctx) != ""
        assert _routing_hint_for_scope(survey_ctx) == ""
        assert _routing_hint_for_scope(None) == ""

    @pytest.mark.asyncio
    async def test_resolve_crystal_skill_match_biases_query_for_tag_scope(self):
        """registry.find has no scope param — the only way to bias routing is the
        query text itself. Assert the hint text actually reaches registry.find."""
        from crystalos.crystal.context import CrystalContext
        captured_queries = []

        async def fake_find(query, top_k=5):
            captured_queries.append(query)
            return [({"name": "tag-analyst"}, 0.9)]

        mock_registry = MagicMock()
        mock_registry.find = fake_find
        mock_registry.find_sync = MagicMock(return_value=None)

        tag_ctx = CrystalContext(org_id="o", user_id="u", survey_id=None, scope="tag", tag_ids=("t1",))
        meta, score = await _resolve_crystal_skill_match(mock_registry, "how's onboarding doing", ctx=tag_ctx)
        assert meta["name"] == "tag-analyst"
        assert "how's onboarding doing" in captured_queries[0]
        assert captured_queries[0] != "how's onboarding doing"  # hint text was appended

    @pytest.mark.asyncio
    async def test_fetch_skill_context_uses_tag_id_args_for_tag_scope(self):
        """_fetch_skill_context must call tag-scoped tools with tag_id/tag_ids
        args (not survey_id) when ctx.scope == 'tag'."""
        from crystalos.crystal.context import CrystalContext

        captured_calls = []

        async def fake_dispatch(tool_name, ctx, args):
            captured_calls.append((tool_name, args))
            return {"ok": True}

        ctx = CrystalContext(org_id="o", user_id="u", survey_id=None, scope="tag", tag_ids=("tag-9",))
        skill_meta = {"name": "tag-analyst", "allowed_tools": [
            "get_tag_report", "get_group_topics", "get_group_metrics", "get_tag_report_trail",
        ]}
        inp = CrystalInput(survey_id="", org_id="o", message="how's this tag doing?", insights=[], scope="tag")

        with patch("crystalos.crystal.tools.dispatch_tool", new=fake_dispatch):
            results = await _fetch_skill_context(inp, skill_meta, ctx)

        assert len(results) == 3  # capped at 3
        tool_names = [c[0] for c in captured_calls]
        assert tool_names[0] == "get_tag_report"
        assert captured_calls[0][1] == {"tag_id": "tag-9"}
        assert captured_calls[1][1] == {"tag_ids": ["tag-9"]}

    @pytest.mark.asyncio
    async def test_run_skill_stream_prefetches_tag_tools_for_tag_scope(self):
        """End-to-end through _run_skill_stream: a tag-scoped request must
        dispatch get_tag_report (not a survey-scoped tool) during prefetch."""
        skill_meta = {
            "name": "tag-analyst",
            "description": "Tag-scoped analyst",
            "allowed_tools": ["get_tag_report", "get_group_topics"],
            "_body": "", "_dir": "/tmp", "version": "1.0.0", "evals": "EVALS.md",
            "max_output_tokens": 2000, "max_retries": 1, "timeout_seconds": 60,
        }
        mock_registry = MagicMock()
        mock_registry._initialized = True
        mock_registry._skills = {"tag-analyst": skill_meta}
        mock_registry.find = AsyncMock(return_value=[(skill_meta, 0.85)])
        mock_registry.find_sync = MagicMock(return_value=None)

        skill_out = CrystalOutput(answer="Tag-wide NPS is up.", citations=[], suggestions=[])
        captured_calls = []

        async def fake_dispatch(tool_name, ctx, args):
            captured_calls.append((tool_name, args))
            return {"response_count": 10}

        inp = CrystalInput(survey_id="", org_id="org1", message="how's this tag doing?",
                            insights=[], scope="tag", tag_id="tag-5")

        with (
            patch("crystalos.agents.crystal._crystal_rate_count", new=AsyncMock(return_value=0)),
            patch("crystalos.lib.skill_registry.get_registry", return_value=mock_registry),
            patch("crystalos.crystal.tools.dispatch_tool", new=fake_dispatch),
            patch("crystalos.agents.crystal._skill_synthesis", new=AsyncMock(return_value=skill_out)),
        ):
            events = []
            async for line in _run_skill_stream(inp):
                events.append(json.loads(line))

        tool_names = [c[0] for c in captured_calls]
        assert "get_tag_report" in tool_names
        assert "get_survey_overview" not in tool_names
        args_for_get_tag_report = next(a for n, a in captured_calls if n == "get_tag_report")
        assert args_for_get_tag_report == {"tag_id": "tag-5"}
