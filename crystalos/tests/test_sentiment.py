"""Unit tests for tools/sentiment.py's ABSA JSON parsing/repair logic.

Mock rules (CLAUDE.md): never call real LLMs. These tests exercise the pure
parsing/repair functions directly with hand-constructed LLM-response strings;
the `run_absa_llm`-level tests use AsyncMock for the llm_func callable.
"""
import json

import pytest

from crystalos.tools.sentiment import (
    _extract_valid_absa_objects,
    _parse_absa_batch,
    _repair_truncated_json_array,
    run_absa_llm,
)


def _batch(*response_ids: str) -> list[dict]:
    return [
        {"response_id": rid, "question_id": "q1", "text": f"text for {rid}"}
        for rid in response_ids
    ]


def _item(i: int, aspect="general", sentiment="positive", score=0.5, emotion="joy") -> str:
    return f'{{"i":{i},"aspect":"{aspect}","sentiment":"{sentiment}","score":{score},"emotion":"{emotion}"}}'


# ── Happy path — sanity, unaffected by the added recovery tiers ───────────────

class TestParseAbsaBatchHappyPath:
    def test_well_formed_array_parses_normally(self):
        raw = "[" + ",".join([
            _item(1, aspect="wait time", sentiment="negative", score=-0.8, emotion="frustration"),
            _item(2, aspect="pricing", sentiment="positive", score=0.7, emotion="satisfaction"),
        ]) + "]"
        results = _parse_absa_batch(raw, _batch("r1", "r2"))

        assert results[0]["sentiment"] == "negative"
        assert results[0]["emotion"] == "frustration"
        assert results[1]["sentiment"] == "positive"
        assert results[1]["emotion"] == "satisfaction"


# ── strict=False: raw control character inside a string ───────────────────────

class TestStrictFalseControlCharacterRecovery:
    def test_literal_newline_inside_a_string_value_no_longer_breaks_the_whole_array(self):
        """Regression test: the LLM sometimes pastes a verbatim response's own
        line break directly into a JSON string instead of escaping it as
        \\n — under strict JSON parsing this raises 'Invalid control
        character' for the WHOLE array. strict=False accepts it directly,
        recovering ALL items on the first parse attempt (no need to fall
        back to per-object extraction, which would still work but is more
        expensive and each recovered object loses nothing here)."""
        raw = (
            '[{"i":1,"aspect":"wait time","sentiment":"negative","score":-0.8,"emotion":"frustration"},'
            '{"i":2,"aspect":"the agent never\nfollowed up","sentiment":"negative","score":-0.6,"emotion":"disappointment"},'
            '{"i":3,"aspect":"pricing","sentiment":"positive","score":0.7,"emotion":"satisfaction"}]'
        )
        results = _parse_absa_batch(raw, _batch("r1", "r2", "r3"))

        assert [r["sentiment"] for r in results] == ["negative", "negative", "positive"]
        assert results[1]["emotion"] == "disappointment"  # real LLM data, not the heuristic fallback


# ── Per-object extraction: one corrupted object must not sink the batch ───────

class TestPerObjectExtractionRecovery:
    def test_mid_batch_unescaped_quote_only_loses_the_one_corrupted_item(self):
        """THE production incident this fix addresses: a single malformed
        object ANYWHERE in the batch (here: response #2's own verbatim text
        contained an unescaped quote the LLM copied straight into the JSON
        string) breaks json.loads for the ENTIRE array — even though items 1
        and 3 are perfectly well-formed. Must recover 1 and 3 with their
        real LLM sentiment/emotion, and only fall back to the heuristic for
        the one item that genuinely couldn't be parsed — not silently
        discard every other response's real analysis for one bad item."""
        raw = (
            '[{"i":1,"aspect":"wait time","sentiment":"negative","score":-0.8,"emotion":"frustration"},'
            '{"i":2,"aspect":"support said "it will be fixed soon" but wasn\'t","sentiment":"negative","score":-0.6,"emotion":"disappointment"},'
            '{"i":3,"aspect":"pricing","sentiment":"positive","score":0.7,"emotion":"satisfaction"}]'
        )
        results = _parse_absa_batch(raw, _batch("r1", "r2", "r3"))

        assert results[0]["sentiment"] == "negative"
        assert results[0]["emotion"] == "frustration"
        assert results[2]["sentiment"] == "positive"
        assert results[2]["emotion"] == "satisfaction"
        # r2 fell back to the heuristic (score-keyword based) — the module
        # never raises and never drops a response, but it can't recover data
        # that was never validly parseable in the first place.
        assert results[1]["response_id"] == "r2"
        assert results[1]["sentiment"] in {"positive", "negative", "neutral"}

    def test_unterminated_string_from_a_trailing_backslash_is_also_recovered(self):
        """A different corruption mechanism (a verbatim response ending in a
        backslash escapes the JSON closing quote, e.g. a pasted Windows
        path) reproduces the exact 'Unterminated string' class from the
        production log — must degrade the same way: recover the healthy
        neighbors, heuristic-fallback only the corrupted one."""
        raw = (
            '[{"i":1,"aspect":"wait time","sentiment":"negative","score":-0.8,"emotion":"frustration"},'
            '{"i":2,"aspect":"broken path C:\\\\","sentiment":"negative","score":-0.6,"emotion":"disappointment"},'
            '{"i":3,"aspect":"pricing","sentiment":"positive","score":0.7,"emotion":"satisfaction"}]'
        )
        results = _parse_absa_batch(raw, _batch("r1", "r2", "r3"))

        assert results[0]["sentiment"] == "negative"
        assert results[2]["sentiment"] == "positive"
        assert results[2]["emotion"] == "satisfaction"


class TestExtractValidAbsaObjects:
    def test_extracts_only_the_well_formed_objects(self):
        raw = (
            '[{"i":1,"aspect":"a","sentiment":"positive","score":0.5,"emotion":"joy"},'
            '{"i":2,"aspect":"broken \'sentiment":"negative","score":-0.5,"emotion":"anger"},'
            '{"i":3,"aspect":"c","sentiment":"neutral","score":0.0,"emotion":"neutral"}]'
        )
        objs = _extract_valid_absa_objects(raw)
        assert [o["i"] for o in objs] == [1, 3]

    def test_returns_empty_list_for_totally_unparseable_text(self):
        assert _extract_valid_absa_objects("not json at all, sorry, I can't help with that") == []

    def test_empty_string_returns_empty_list(self):
        assert _extract_valid_absa_objects("") == []


# ── Fully unrecoverable batch — must still degrade gracefully, never raise ────

class TestFullyUnrecoverableBatch:
    def test_parse_absa_batch_still_raises_when_nothing_at_all_is_recoverable(self):
        """A genuinely unusable response (zero parseable objects, not just
        one bad item) must still surface as a real failure — re-raising the
        original JSONDecodeError, exactly as before this fix — rather than
        silently succeeding with an empty array. The observability signal
        (this batch's LLM output was actually garbage) must not go missing
        just because the recovery logic got more lenient for partial cases."""
        raw = "I'm not able to provide that analysis right now."
        with pytest.raises(json.JSONDecodeError):
            _parse_absa_batch(raw, _batch("r1", "r2"))

    @pytest.mark.asyncio
    async def test_run_absa_llm_still_degrades_the_whole_batch_to_heuristic_on_total_failure(self):
        """End-to-end (matches the real call path / the production
        traceback): run_absa_llm's own except-block still logs
        'absa_batch_failed' and falls back to _heuristic_batch for a
        completely unparseable LLM response — unchanged from before this
        fix. Never raises out to the caller."""
        from unittest.mock import AsyncMock

        llm_func = AsyncMock(return_value="I'm not able to provide that analysis right now.")
        texts = [{"response_id": "r1", "question_id": "q1", "text": "great support"}]

        results = await run_absa_llm(texts, llm_func)

        assert len(results) == 1
        assert results[0]["response_id"] == "r1"
        assert results[0]["sentiment"] in {"positive", "negative", "neutral"}


# ── Existing truncation repair — untouched, still works under strict=False ────

class TestTruncatedArrayRepairStillWorks:
    def test_repair_truncated_json_array_closes_after_last_complete_object(self):
        cut_off = '[' + _item(1) + ',{"i":2,"aspect":"cut off mid'
        repaired = _repair_truncated_json_array(cut_off)
        parsed = json.loads(repaired, strict=False)
        assert len(parsed) == 1
        assert parsed[0]["i"] == 1

    def test_llm_hitting_token_limit_mid_response_still_recovers_the_complete_items(self):
        raw = "[" + _item(1, sentiment="negative", score=-0.9, emotion="anger") + ',{"i":2,"aspect":"cut off mid-wo'
        results = _parse_absa_batch(raw, _batch("r1", "r2"))

        assert results[0]["sentiment"] == "negative"
        assert results[0]["emotion"] == "anger"
        # r2 was never completed by the LLM at all — heuristic fallback.
        assert results[1]["sentiment"] in {"positive", "negative", "neutral"}
