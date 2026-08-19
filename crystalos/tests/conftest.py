"""Shared fixtures for agents unit tests.

Tests are isolated from the real LLM APIs by mocking `call_agent()`.
This ensures:
  - Tests run without API keys
  - Tests are deterministic (no flaky LLM non-determinism)
  - Tests are fast (no network calls)

Integration tests (with real API calls) live in agents/evals/.
"""
import json
from unittest.mock import AsyncMock, patch

import pytest

from crystalos.lib.credits import CreditEntry


def make_credit(agent: str = "test", model: str = "test-model", tokens_in: int = 100, tokens_out: int = 200) -> CreditEntry:
    return CreditEntry(
        agent=agent,
        model=model,
        input_tokens=tokens_in,
        output_tokens=tokens_out,
        cost_usd=0.0,
    )


SAMPLE_QUESTIONS = [
    {
        "id": "q1", "type": "nps", "question": "How likely are you to recommend us?",
        "required": True, "labelLow": "Not likely", "labelHigh": "Very likely",
    },
    {
        "id": "q2", "type": "rating", "question": "How satisfied are you?",
        "required": True, "scaleMax": 5, "labelLow": "Poor", "labelHigh": "Excellent",
    },
    {
        "id": "q3", "type": "multiple_choice", "question": "What did you enjoy most?",
        "required": True,
        "options": ["Product quality", "Customer service", "Price", "Delivery speed"],
    },
    {
        "id": "q4", "type": "multiple_choice", "question": "What area needs improvement?",
        "required": True,
        "options": ["Speed", "Pricing", "Support", "Features"],
    },
    {
        "id": "q5", "type": "open_text",
        "question": "What else would you like us to know?",
        "required": False,
    },
]


@pytest.fixture
def sample_questions():
    return SAMPLE_QUESTIONS


@pytest.fixture
def sample_org_context():
    return {
        "industry": "technology",
        "size": "51-200",
        "use_case": "cx",
        "target_audience": "enterprise customers",
        "prior_survey_count": 3,
    }


def assert_tool_ok(result: dict, tool_name: str | None = None) -> None:
    """Assert a tool-executor / dispatch_tool result dict represents success.

    Mirrors the ad-hoc `"error" not in result` checks already scattered across
    this test suite — use this shared helper going forward instead of
    repeating the inline check.
    """
    label = f" for tool {tool_name!r}" if tool_name else ""
    assert "error" not in result, f"expected no error{label}, got: {result.get('error')!r}"
