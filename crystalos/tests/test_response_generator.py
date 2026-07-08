"""Unit tests for agents/response_generator.py.

Regression coverage for the 2026-07-06 fix: _BATCH_SIZE=5 was too large for
surveys with many/verbose questions, pushing response_gen's LLM output past
its token budget and truncating mid-JSON ("EOF while parsing a string").
call_agent's retry loop resends the same prompt at the same token budget, so
a truncation caused purely by output size doesn't self-heal by retrying — it
fails the same way every attempt and the batch silently returns 0 responses.
Batch size was lowered (5 -> 3) and response_gen's max_tokens raised
(8000 -> 12000 in paid envs; see tests/test_models.py::MIN_TOKENS).
"""
import pytest
from unittest.mock import AsyncMock, patch

from crystalos.agents.response_generator import (
    _BATCH_SIZE, _generate_batch, ResponseGenInput, ResponseGenBatch, GeneratedResponse,
)


class TestBatchSize:
    def test_batch_size_is_small_enough_to_avoid_truncation(self):
        """Regression guard: don't silently creep this back up to a size that
        risks pushing output past response_gen's token budget."""
        assert _BATCH_SIZE <= 3


class TestGenerateBatchFailureIsolation:
    def _input(self, count=3):
        return ResponseGenInput(
            survey_id="s1", org_id="o1", survey_title="Test Survey",
            questions=[{"id": "q1", "type": "open_text", "question": "Anything else?"}],
            count=count,
        )

    @pytest.mark.asyncio
    async def test_truncated_json_failure_returns_empty_list_not_raise(self):
        """A truncated/invalid JSON response (AgentOutputError after retries
        exhausted) must degrade to an empty batch, not crash the whole
        generation run — other batches can still succeed independently."""
        with patch(
            "crystalos.agents.response_generator.call_agent",
            new=AsyncMock(side_effect=ValueError('Invalid JSON: EOF while parsing a string')),
        ):
            result = await _generate_batch(self._input(), batch_n=3, offset=0)
        assert result == []

    @pytest.mark.asyncio
    async def test_successful_batch_returns_responses(self):
        fake_output = ResponseGenBatch(responses=[
            GeneratedResponse(persona="Happy user", nps_score=9, answers=[]),
        ])
        with patch(
            "crystalos.agents.response_generator.call_agent",
            new=AsyncMock(return_value=(fake_output, {})),
        ):
            result = await _generate_batch(self._input(), batch_n=1, offset=0)
        assert len(result) == 1
        assert result[0].persona == "Happy user"
