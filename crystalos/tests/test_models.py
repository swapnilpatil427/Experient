"""Tests for the ENV-based model router.

Philosophy — test PROPERTIES not model names:
  - Never assert a specific model string (e.g. "deepseek", "gemini", "openai").
    Model choices change frequently; tests that pin specific names break on every update.
  - DO assert structural properties: vendor diversity (QC != creator), free-tier flag,
    token minimums, SDK flags, context window floors.
  - Policy exceptions are documented with a named constant so a policy change
    updates one place, not every test.

Properties verified:
  - Every env has every required agent key
  - Cross-vendor QC rule: qc vendor != creator vendor in every env
  - Dev uses only :free models; paid envs use no :free models
  - No Anthropic SDK in any env (all route through OpenRouter)
  - Token budgets meet minimum thresholds per role
  - Context windows are set and positive
  - get_env() falls back to "dev" for unknown values
  - get_skill_model() returns a ModelConfig and falls back gracefully
  - list_skill_models() returns all skill names for the current env
"""
import os
import pytest
from unittest.mock import patch

from crystalos.lib.models import (
    _ROUTING,
    _SKILL_ROUTING,
    _VALID_ENVS,
    AgentName,
    ModelConfig,
    get_env,
    get_model,
    get_skill_model,
    list_skill_models,
    requires_anthropic_key,
    requires_openrouter_key,
)

# Agents that MUST be present in every env (core pipeline)
REQUIRED_AGENTS: list[str] = [
    "creator", "qc", "qc_validator", "compliance", "recommender",
    "insight_narrate", "insight_verify", "insight_topics",
    "crystal", "crystal_eval", "insight_expert", "insight_evaluate",
    "skip-logic", "copilot", "response_gen",
    "survey_bias", "survey_evaluate",
    "report_headline", "report_summary", "report_full",
]
ALL_ENVS: list[str] = ["dev", "dev-paid", "staging", "prod"]
FREE_ENVS: list[str] = ["dev"]
PAID_ENVS: list[str] = ["dev-paid", "staging", "prod"]

# Skills that MUST be present in every skill routing env
REQUIRED_SKILLS: list[str] = [
    "insight-narrator", "action-recommender", "crystal-analyst",
    "specialist-nps", "specialist-ces", "specialist-csat", "specialist-enps", "specialist-custom",
    "nps-action-advisor", "ces-action-advisor", "csat-action-advisor", "enps-action-advisor",
    "close-the-loop-advisor", "predictive-action-advisor",
    "survey-qc", "compliance-scanner",
    "survey-creator", "copilot-analyst", "survey-refiner", "survey-recommender",
    "survey-improvement-advisor", "distribution-strategist",
    "benchmark-strategist", "voc-program-advisor", "segment-action-advisor", "journey-advisor",
]

# Policy: QC skills that must never use the same vendor as their creator counterpart.
# This is an architectural policy — changing it requires deliberate review.
# Note: qc_validator is a secondary formatting validator, NOT the primary QC reviewer,
# so the cross-vendor rule applies only to the main 'qc' reviewer.
QC_PAIRS = [
    ("creator", "qc"),  # pipeline: survey creator vs primary QC reviewer
]
SKILL_QC_PAIRS = [
    ("survey-creator", "survey-qc"),          # skill: creator vs QC
    ("survey-creator", "compliance-scanner"),  # skill: creator vs compliance
]

# Minimum token budgets by role category (must be met in ALL paid envs)
MIN_TOKENS = {
    "creator":         2000,   # complex multi-section survey generation
    "insight_narrate": 800,    # narrative per insight (batched)
    "insight_topics":  4000,   # topic cluster discovery
    "insight_expert":  800,    # per-specialist narration
    "crystal":         600,    # Q&A response
    "report_full":     10000,  # full narrative report
    # Regression floor for the 2026-07-06 fix: 8000 was too tight for
    # agents/response_generator.py's batch of responses (each with full
    # answers arrays across every question) and caused real truncated-JSON
    # failures ("EOF while parsing a string") in production. Batch size was
    # also lowered (5 -> 3) alongside this — see response_generator.py.
    "response_gen":    10000,
}
SKILL_MIN_TOKENS = {
    "insight-narrator":  2000,  # 5 layered findings + summary + actions
    "action-recommender": 800,  # 5 de-duplicated actions + summary
    "survey-creator":    3000,  # 8-12 questions with full schemas
    "copilot-analyst":   1500,  # full questions array + explanation
    "crystal-analyst":    800,  # answer + citations + suggestions
}

# Minimum context windows by role
MIN_CONTEXT = {
    "creator":        32_000,
    "insight_topics": 64_000,
    "crystal":        64_000,
}
SKILL_MIN_CONTEXT = {
    "crystal-analyst":  256_000,  # multi-turn conversation + full survey context
    "survey-creator":    64_000,  # complex intent + org context
    "copilot-analyst":  256_000,  # full questions array + history
}


# ── Routing table completeness ─────────────────────────────────────────────────

class TestPipelineRoutingCompleteness:
    def test_all_envs_present(self):
        for env in ALL_ENVS:
            assert env in _ROUTING, f"Missing env '{env}' in _ROUTING"

    def test_all_required_agents_in_every_env(self):
        for env in ALL_ENVS:
            for agent in REQUIRED_AGENTS:
                assert agent in _ROUTING[env], f"Missing agent '{agent}' in _ROUTING['{env}']"

    def test_all_configs_are_model_config(self):
        for env in ALL_ENVS:
            for agent, cfg in _ROUTING[env].items():
                assert isinstance(cfg, ModelConfig), f"_ROUTING['{env}']['{agent}'] is not a ModelConfig"

    def test_valid_envs_set_matches_routing(self):
        assert _VALID_ENVS == set(ALL_ENVS)


class TestSkillRoutingCompleteness:
    def test_all_envs_present(self):
        for env in ALL_ENVS:
            assert env in _SKILL_ROUTING, f"Missing env '{env}' in _SKILL_ROUTING"

    def test_all_required_skills_in_every_env(self):
        for env in ALL_ENVS:
            for skill in REQUIRED_SKILLS:
                assert skill in _SKILL_ROUTING[env], (
                    f"Missing skill '{skill}' in _SKILL_ROUTING['{env}']. "
                    f"Add it to the {env} dict in models.py."
                )

    def test_all_skill_configs_are_model_config(self):
        for env in ALL_ENVS:
            for skill, cfg in _SKILL_ROUTING[env].items():
                assert isinstance(cfg, ModelConfig), (
                    f"_SKILL_ROUTING['{env}']['{skill}'] is not a ModelConfig"
                )


# ── Cross-vendor QC rule ───────────────────────────────────────────────────────
# Property: QC must use a DIFFERENT provider than Creator in every env.
# This prevents self-confirmation bias (model reviewing its own vendor's output).
# We test the PROPERTY (vendors differ), not WHICH vendors — so tests survive model changes.

class TestCrossVendorQCRule:
    @pytest.mark.parametrize("env", ALL_ENVS)
    @pytest.mark.parametrize("creator_agent,qc_agent", QC_PAIRS)
    def test_pipeline_qc_vendor_differs_from_creator(self, env, creator_agent, qc_agent):
        creator_vendor = _ROUTING[env][creator_agent].model.split("/")[0]
        qc_vendor      = _ROUTING[env][qc_agent].model.split("/")[0]
        assert creator_vendor != qc_vendor, (
            f"{env}: {qc_agent} uses same vendor ('{qc_vendor}') as {creator_agent}. "
            f"Cross-vendor QC rule violated — pick a different provider for QC."
        )

    @pytest.mark.parametrize("env", ALL_ENVS)
    @pytest.mark.parametrize("creator_skill,qc_skill", SKILL_QC_PAIRS)
    def test_skill_qc_vendor_differs_from_creator(self, env, creator_skill, qc_skill):
        creator_vendor = _SKILL_ROUTING[env][creator_skill].model.split("/")[0]
        qc_vendor      = _SKILL_ROUTING[env][qc_skill].model.split("/")[0]
        assert creator_vendor != qc_vendor, (
            f"{env}: skill '{qc_skill}' uses same vendor ('{qc_vendor}') as '{creator_skill}'. "
            f"Cross-vendor QC rule violated for skill routing."
        )


# ── Free vs paid model enforcement ────────────────────────────────────────────

class TestFreeVsPaidTiers:
    def test_dev_pipeline_models_are_all_free(self):
        """Dev uses :free-suffix models to avoid any API cost during local development."""
        for agent, cfg in _ROUTING["dev"].items():
            assert cfg.model.endswith(":free"), (
                f"dev/{agent} model '{cfg.model}' is not a free-tier model. "
                f"Use a ':free' suffixed model for the dev environment."
            )

    def test_dev_skill_models_are_all_free(self):
        """Skill routing for dev must also use free models."""
        for skill, cfg in _SKILL_ROUTING["dev"].items():
            assert cfg.model.endswith(":free"), (
                f"dev skill '{skill}' model '{cfg.model}' is not free-tier. "
                f"Use a ':free' suffixed model for dev."
            )

    @pytest.mark.parametrize("env", PAID_ENVS)
    def test_paid_pipeline_models_are_not_free(self, env):
        """Non-dev environments must not accidentally use rate-limited free models."""
        for agent, cfg in _ROUTING[env].items():
            assert not cfg.model.endswith(":free"), (
                f"{env}/{agent} uses free-tier model '{cfg.model}'. "
                f"Paid environments should use paid models for reliability."
            )

    @pytest.mark.parametrize("env", PAID_ENVS)
    def test_paid_skill_models_are_not_free(self, env):
        for skill, cfg in _SKILL_ROUTING[env].items():
            assert not cfg.model.endswith(":free"), (
                f"{env} skill '{skill}' uses free-tier model '{cfg.model}'. "
                f"Paid environments should use paid models."
            )


# ── SDK flags ─────────────────────────────────────────────────────────────────

class TestSdkFlags:
    @pytest.mark.parametrize("env", ALL_ENVS)
    def test_no_anthropic_sdk_in_any_env(self, env):
        """All envs route through OpenRouter — no direct Anthropic SDK calls."""
        for agent, cfg in _ROUTING[env].items():
            assert not cfg.use_anthropic_sdk, (
                f"{env}/{agent}: use_anthropic_sdk=True. "
                f"All agents must use OpenRouter (OPENROUTER_API_KEY), not the Anthropic SDK."
            )

    @pytest.mark.parametrize("env", ALL_ENVS)
    def test_no_thinking_in_any_env(self, env):
        """Thinking mode requires special SDK handling. Currently disabled across all envs."""
        for agent, cfg in _ROUTING[env].items():
            assert not cfg.use_thinking, (
                f"{env}/{agent}: use_thinking=True. "
                f"Thinking mode is not currently supported in this routing setup."
            )


# ── Token budgets ──────────────────────────────────────────────────────────────

class TestTokenBudgets:
    @pytest.mark.parametrize("env", ALL_ENVS)
    @pytest.mark.parametrize("agent", REQUIRED_AGENTS)
    def test_all_pipeline_max_tokens_positive(self, env, agent):
        assert _ROUTING[env][agent].max_tokens > 0

    @pytest.mark.parametrize("env", PAID_ENVS)
    @pytest.mark.parametrize("agent,min_tokens", MIN_TOKENS.items())
    def test_pipeline_token_minimums_in_paid_envs(self, env, agent, min_tokens):
        """Paid environments must meet minimum token budgets for quality output."""
        actual = _ROUTING[env][agent].max_tokens
        assert actual >= min_tokens, (
            f"{env}/{agent}: max_tokens={actual} < minimum {min_tokens}. "
            f"Increase the token budget to ensure quality output."
        )

    @pytest.mark.parametrize("env", ALL_ENVS)
    def test_creator_has_more_tokens_than_validators(self, env):
        """Creator produces longer output than QC/compliance reviewers."""
        creator_tokens = _ROUTING[env]["creator"].max_tokens
        for reviewer in ("qc_validator", "compliance"):
            reviewer_tokens = _ROUTING[env][reviewer].max_tokens
            assert creator_tokens > reviewer_tokens, (
                f"{env}: creator ({creator_tokens}) should have more tokens than "
                f"{reviewer} ({reviewer_tokens})"
            )

    @pytest.mark.parametrize("env", PAID_ENVS)
    @pytest.mark.parametrize("skill,min_tokens", SKILL_MIN_TOKENS.items())
    def test_skill_token_minimums_in_paid_envs(self, env, skill, min_tokens):
        actual = _SKILL_ROUTING[env][skill].max_tokens
        assert actual >= min_tokens, (
            f"{env} skill '{skill}': max_tokens={actual} < minimum {min_tokens}."
        )

    @pytest.mark.parametrize("env", ALL_ENVS)
    @pytest.mark.parametrize("skill", REQUIRED_SKILLS)
    def test_all_skill_max_tokens_positive(self, env, skill):
        assert _SKILL_ROUTING[env][skill].max_tokens > 0


# ── Context windows ────────────────────────────────────────────────────────────

class TestContextWindows:
    @pytest.mark.parametrize("env", ALL_ENVS)
    @pytest.mark.parametrize("agent", REQUIRED_AGENTS)
    def test_all_pipeline_context_windows_positive(self, env, agent):
        assert _ROUTING[env][agent].context_window > 0

    @pytest.mark.parametrize("env", PAID_ENVS)
    @pytest.mark.parametrize("agent,min_ctx", MIN_CONTEXT.items())
    def test_pipeline_context_minimums(self, env, agent, min_ctx):
        actual = _ROUTING[env][agent].context_window
        assert actual >= min_ctx, (
            f"{env}/{agent}: context_window={actual} < minimum {min_ctx}."
        )

    @pytest.mark.parametrize("env", PAID_ENVS)
    @pytest.mark.parametrize("skill,min_ctx", SKILL_MIN_CONTEXT.items())
    def test_skill_context_minimums(self, env, skill, min_ctx):
        actual = _SKILL_ROUTING[env][skill].context_window
        assert actual >= min_ctx, (
            f"{env} skill '{skill}': context_window={actual} < minimum {min_ctx}."
        )


# ── Temperature ────────────────────────────────────────────────────────────────

class TestTemperature:
    @pytest.mark.parametrize("env", ALL_ENVS)
    def test_no_thinking_means_temperature_required(self, env):
        """Models without thinking mode require an explicit temperature."""
        for agent, cfg in _ROUTING[env].items():
            if not cfg.use_thinking:
                assert cfg.temperature is not None, (
                    f"{env}/{agent}: temperature=None but use_thinking=False. "
                    f"Set an explicit temperature when not using thinking mode."
                )


# ── Model format ───────────────────────────────────────────────────────────────

class TestModelFormat:
    @pytest.mark.parametrize("env", ALL_ENVS)
    def test_pipeline_model_ids_have_provider_prefix(self, env):
        """All model IDs must be in 'provider/model-name' format."""
        for agent, cfg in _ROUTING[env].items():
            assert "/" in cfg.model, (
                f"{env}/{agent}: model '{cfg.model}' missing provider prefix. "
                f"Expected format: 'provider/model-name' or 'provider/model:tag'."
            )

    @pytest.mark.parametrize("env", ALL_ENVS)
    def test_skill_model_ids_have_provider_prefix(self, env):
        for skill, cfg in _SKILL_ROUTING[env].items():
            assert "/" in cfg.model, (
                f"{env} skill '{skill}': model '{cfg.model}' missing provider prefix."
            )


# ── get_env() ─────────────────────────────────────────────────────────────────

class TestGetEnv:
    @pytest.mark.parametrize("env", ALL_ENVS)
    def test_valid_envs_returned_as_is(self, env):
        with patch.dict(os.environ, {"AGENTS_ENV": env}):
            assert get_env() == env

    def test_unknown_env_falls_back_to_dev(self):
        with patch.dict(os.environ, {"AGENTS_ENV": "production"}):
            assert get_env() == "dev"

    def test_empty_env_falls_back_to_dev(self):
        with patch.dict(os.environ, {"AGENTS_ENV": ""}):
            assert get_env() == "dev"

    def test_missing_env_var_defaults_to_dev(self):
        env_copy = os.environ.copy()
        env_copy.pop("AGENTS_ENV", None)
        with patch.dict(os.environ, env_copy, clear=True):
            assert get_env() == "dev"


# ── get_model() / get_skill_model() ───────────────────────────────────────────

class TestGetModel:
    @pytest.mark.parametrize("env", ALL_ENVS)
    @pytest.mark.parametrize("agent", REQUIRED_AGENTS)
    def test_returns_model_config_for_all_combinations(self, env, agent):
        with patch.dict(os.environ, {"AGENTS_ENV": env}):
            cfg = get_model(agent)  # type: ignore[arg-type]
            assert isinstance(cfg, ModelConfig)
            assert cfg.model

    def test_unknown_env_uses_dev_model(self):
        with patch.dict(os.environ, {"AGENTS_ENV": "unknown"}):
            cfg = get_model("creator")
            assert cfg == _ROUTING["dev"]["creator"]


class TestGetSkillModel:
    @pytest.mark.parametrize("env", ALL_ENVS)
    @pytest.mark.parametrize("skill", REQUIRED_SKILLS)
    def test_returns_model_config_for_all_skills(self, env, skill):
        with patch.dict(os.environ, {"AGENTS_ENV": env}):
            cfg = get_skill_model(skill)
            assert isinstance(cfg, ModelConfig)
            assert cfg.model
            assert cfg.max_tokens > 0

    def test_unknown_skill_falls_back_gracefully(self):
        """An unregistered skill name must return a valid fallback config, not raise."""
        with patch.dict(os.environ, {"AGENTS_ENV": "prod"}):
            cfg = get_skill_model("some-new-skill-not-yet-in-table")
            assert isinstance(cfg, ModelConfig)
            assert cfg.model  # must be non-empty string

    @pytest.mark.parametrize("env", ALL_ENVS)
    def test_fallback_model_is_valid(self, env):
        """Fallback must produce a model that's in the routing table (not None/empty)."""
        with patch.dict(os.environ, {"AGENTS_ENV": env}):
            cfg = get_skill_model("nonexistent-skill-xyz")
            assert "/" in cfg.model  # must have provider/model format

    def test_list_skill_models_returns_all_registered_skills(self):
        """list_skill_models() must return an entry for every REQUIRED_SKILLS member."""
        with patch.dict(os.environ, {"AGENTS_ENV": "prod"}):
            models = list_skill_models()
            for skill in REQUIRED_SKILLS:
                assert skill in models, f"'{skill}' missing from list_skill_models() output"
            # All values must be non-empty model strings
            for skill, model in models.items():
                assert model and "/" in model, (
                    f"list_skill_models() returned invalid model '{model}' for skill '{skill}'"
                )


# ── API key requirements ───────────────────────────────────────────────────────

class TestKeyRequirements:
    @pytest.mark.parametrize("env", ALL_ENVS)
    def test_no_env_requires_anthropic_key(self, env):
        """All envs route through OpenRouter — no Anthropic SDK in any env."""
        with patch.dict(os.environ, {"AGENTS_ENV": env}):
            assert not requires_anthropic_key(), (
                f"{env} should not require Anthropic key — all agents use OpenRouter."
            )

    @pytest.mark.parametrize("env", ALL_ENVS)
    def test_all_envs_require_openrouter_key(self, env):
        """All envs use OpenRouter — OPENROUTER_API_KEY always needed."""
        with patch.dict(os.environ, {"AGENTS_ENV": env}):
            assert requires_openrouter_key()
