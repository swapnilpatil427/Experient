"""Tests for agents/insight_experts.py output schemas.

Regression coverage for the narrative-length validation failure: call_agent()'s retry
loop can't reliably get an LLM to self-enforce a precise character budget (see
prescriptive_expert_failed in graphs/insights.py), so overlong narratives are now
truncated in a `field_validator(mode="before")` instead of failing pydantic validation
after 3 wasted retries and falling back to a generic canned narrative.
"""
import pytest

from crystalos.agents.insight_experts import (
    _NARRATIVE_MAX_LEN,
    _truncate_narrative,
    CsatExpertOutput,
    NpsExpertOutput,
    PrescriptiveExpertOutput,
    TopicExpertOutput,
    TrendExpertOutput,
)

# All five expert output schemas share the exact same narrative-length bug pattern.
NARRATIVE_SCHEMAS = [
    NpsExpertOutput,
    CsatExpertOutput,
    TopicExpertOutput,
    TrendExpertOutput,
    PrescriptiveExpertOutput,
]

MINIMAL_EXTRA_FIELDS: dict[type, dict] = {
    NpsExpertOutput: {},
    CsatExpertOutput: {},
    TopicExpertOutput: {},
    TrendExpertOutput: {},
    PrescriptiveExpertOutput: {},
}


def test_truncate_narrative_leaves_short_text_unchanged():
    text = "Short and well within the limit."
    assert _truncate_narrative(text) == text


def test_truncate_narrative_cuts_at_sentence_boundary():
    sentence = "This is one grounded analytical sentence about the friction point. "
    long_text = sentence * 20  # well over 900 chars
    result = _truncate_narrative(long_text)
    assert len(result) <= _NARRATIVE_MAX_LEN
    assert result.endswith(".")  # cut cleanly at a sentence end, no mid-word chop


def test_truncate_narrative_falls_back_to_word_boundary_without_sentence_end():
    # No '. '/'! '/'? ' anywhere — must fall back to the last space, not a mid-word cut.
    long_text = "word " * 400  # 2000 chars, no sentence punctuation
    result = _truncate_narrative(long_text)
    assert len(result) <= _NARRATIVE_MAX_LEN
    assert not result.endswith("wor")  # not chopped mid-word
    assert result.endswith("…")


@pytest.mark.parametrize("schema", NARRATIVE_SCHEMAS)
def test_overlong_narrative_does_not_raise_validation_error(schema):
    # Reproduces the reported failure: a real prescriptive-style narrative long enough
    # (>900 chars) to have failed validation 3x in production before this fix.
    overlong = (
        "The 'Food Quality Decline' friction point is the most impactful negative driver "
        "this period, with a strong correlation to detractor scoring across the corpus. "
    ) * 6
    assert len(overlong) > _NARRATIVE_MAX_LEN

    instance = schema(headline="Test headline", narrative=overlong, **MINIMAL_EXTRA_FIELDS[schema])
    assert len(instance.narrative) <= _NARRATIVE_MAX_LEN


@pytest.mark.parametrize("schema", NARRATIVE_SCHEMAS)
def test_narrative_within_limit_is_unaffected(schema):
    narrative = "A concise, well within budget narrative sentence."
    instance = schema(headline="Test headline", narrative=narrative, **MINIMAL_EXTRA_FIELDS[schema])
    assert instance.narrative == narrative
