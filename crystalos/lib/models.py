"""ENV-based model router — pipeline agents + CrystalOS skill runtime.

Provider strategy: DeepSeek v4 as primary reasoning backbone; Google Gemini for writing,
multilingual tasks and cross-vendor QC; Qwen for domain advisory skills and cost-efficient
XM tasks. Zero OpenAI or Anthropic SDK — 75-80% cheaper than Opus 4.7 equivalents.

Two routing tables:
  _ROUTING      → pipeline agents (creator, qc, insight_narrate, crystal, …)
  _SKILL_ROUTING → CrystalOS skills (insight-narrator, survey-qc, crystal-analyst, …)

Environments:
  dev        Free OpenRouter models. OpenAI OSS + Gemma + Qwen free pools. $0 cost.
  dev-paid   DeepSeek v4 Flash for reasoning, incl. Crystal chat; Gemini 2.5 Flash for writing + QC.
             ~$0.008–0.020/skill run. ~$0.015–0.035/pipeline run.
  staging    DeepSeek v4 Pro for all high-reasoning roles (upgraded from R1), incl. Crystal chat.
             Gemini 2.5 Flash for narration / QC / writing.
             ~$0.025–0.060/run (Pro at ~$1.10/1M in vs R1 $0.55/1M).
  prod       Same as staging with higher token budgets and ABSA scale.
             DeepSeek v4 Flash for fast advisory skills (cost vs quality sweet spot).
             ~$0.040–0.100/run with full 12 advisors.

Cross-vendor QC rule (all envs):
  QC agent ALWAYS uses a different vendor than Creator.
  Creator=DeepSeek → QC=Gemini; Creator=Gemini → QC=Qwen.
  Applies to both pipeline agents and CrystalOS skills (survey-qc, compliance-scanner).
  Same pattern covers Crystal's own judge: crystal / crystal-analyst = DeepSeek →
  crystal_eval = Gemini. (2026-08: crystal/crystal-analyst moved off Gemini onto DeepSeek
  at product request for more reasoning/output headroom on citations, suggestions and
  action_proposals — NOT because the deterministic viz/chart payload needs tokens; that
  chart is built by _build_viz_for_citations() in agents/crystal.py *after* the LLM call
  and costs the model nothing. crystal_eval deliberately stays on Gemini so the
  cross-vendor QC rule still holds for Crystal's hallucination check.)

Model routing via OpenRouter only (all envs):
  All models route through OpenRouter (https://openrouter.ai).
  No Anthropic SDK, no direct API calls. OPENROUTER_API_KEY required.

CrystalOS skill model selection rationale (mid-2026):
  deepseek/deepseek-v4-pro     — Best reasoning for complex XM synthesis, 128K ctx
  deepseek/deepseek-v4-flash   — Fast, cheap DeepSeek for advisory + action skills
  google/gemini-2.5-flash      — Best multilingual writing + instruction following, 1M ctx
  google/gemini-2.5-flash      — Fastest/cheapest structured validators, 1M ctx
  qwen/qwen-2.5-72b-instruct   — Excellent APAC XM knowledge, structured advisory
  google/gemma-4-31b-it:free   — Highest quality free tier for narrative tasks
  openai/gpt-oss-120b:free     — Best free reasoning pool (OSS reasoning param)
  qwen/qwen3-coder:free        — Best free structured JSON (1M ctx, coder-tuned)

  crystal / crystal-analyst (2026-08 change) — deepseek/deepseek-v4-flash (dev-paid) /
  deepseek/deepseek-v4-pro (staging, prod). Previously google/gemini-2.5-flash. Moved to
  DeepSeek's reasoning tier for more headroom on citations/suggestions/action_proposals
  richness (product request); max_tokens roughly doubled alongside the move. Tradeoff:
  DeepSeek's documented 128K context_window replaces Gemini's 1M for this role — a real
  decrease in raw model context, accepted because Crystal's actual per-turn input (a
  handful of insights/topics/tool results, not the full corpus) sits far below 128K in
  practice. crystal_eval stays on Gemini (see Cross-vendor QC rule above).
"""
import os
from dataclasses import dataclass
from typing import Literal

AgentName = Literal["creator", "qc", "qc_validator", "compliance", "recommender", "skip-logic", "copilot", "insight_narrate", "insight_verify", "insight_topics", "crystal", "response_gen", "insight_expert", "insight_evaluate", "crystal_eval", "survey_bias", "survey_evaluate", "report_headline", "report_summary", "report_full"]
EnvName   = Literal["dev", "dev-paid", "staging", "prod"]

_VALID_ENVS = {"dev", "dev-paid", "staging", "prod"}


@dataclass(frozen=True)
class ModelConfig:
    model:             str
    max_tokens:        int
    temperature:       float | None  # None = omit (required for Opus 4.7 with thinking)
    use_anthropic_sdk: bool = False   # True = call Anthropic SDK directly (not via OpenRouter)
    use_thinking:      bool = False   # True = adaptive thinking (Opus 4.7 / Sonnet 4.6 only)
    context_window:    int  = 32_000  # tokens available for input context
    absa_concurrency:  int  = 3       # max parallel ABSA batches for this env
    absa_batch_size:   int  = 10      # texts per ABSA LLM call
    absa_cap:          int  = 100     # max new (un-enriched) texts to ABSA per pipeline run


_ROUTING: dict[EnvName, dict[AgentName, ModelConfig]] = {

    # ── dev ─────────────────────────────────────────────────────────────────────
    # 6-pool free-tier setup — each pool is a distinct rate-limit bucket.
    # Verified live on OpenRouter as of 2026-06-01. Run openrouter_scan --check-stale to verify.
    #
    # Pool | Model                                   | Strengths                    | Roles
    # ─────┼─────────────────────────────────────────┼──────────────────────────────┼────────────────────────────
    # OSS120 | openai/gpt-oss-120b:free              | OpenAI reasoning + tools     | creator, insight_topics/expert, report
    # OSS20  | openai/gpt-oss-20b:free               | Fast OpenAI reasoning        | qc_validator, compliance, recommender, copilot
    # Q80    | qwen/qwen3-next-80b-a3b-instruct:free | Cross-vendor QC + evaluation | qc, insight_evaluate
    # GEM    | google/gemma-4-31b-it:free            | Quality writing              | insight_narrate, crystal, report_headline
    # NNO    | nvidia/nemotron-nano-9b-v2:free       | Ultra-fast verify            | insight_verify, crystal_eval
    # QCD    | qwen/qwen3-coder:free                 | Structured JSON              | skip-logic, survey QA
    # KIMI   | moonshotai/kimi-k2.6:free             | Long-context synthesis       | response_gen
    #
    "dev": {
        # OSS-120B — OpenAI free reasoning pool (tools + reasoning param)
        "creator":         ModelConfig("openai/gpt-oss-120b:free",                     max_tokens=4000, temperature=0.3,  context_window=128_000),
        "insight_topics":  ModelConfig("openai/gpt-oss-120b:free",                     max_tokens=6000, temperature=0.0,  context_window=128_000),
        "insight_expert":  ModelConfig("openai/gpt-oss-120b:free",                     max_tokens=1000, temperature=0.1,  context_window=128_000),
        "report_summary":  ModelConfig("openai/gpt-oss-120b:free",                     max_tokens=6000, temperature=0.1,  context_window=128_000),
        "report_full":     ModelConfig("openai/gpt-oss-120b:free",                     max_tokens=30000, temperature=0.0, context_window=128_000),

        # OSS-20B — Fast OpenAI reasoning pool (separate rate-limit bucket from 120B)
        "qc_validator":    ModelConfig("openai/gpt-oss-20b:free",                      max_tokens=400,  temperature=0.1,  context_window=128_000),
        "compliance":      ModelConfig("openai/gpt-oss-20b:free",                      max_tokens=600,  temperature=0.1,  context_window=128_000),
        "recommender":     ModelConfig("openai/gpt-oss-20b:free",                      max_tokens=500,  temperature=0.4,  context_window=128_000),
        "copilot":         ModelConfig("openai/gpt-oss-20b:free",                      max_tokens=1500, temperature=0.3,  context_window=128_000),

        # Qwen 80B — Cross-vendor QC (OpenAI creator → Qwen reviewer)
        "qc":              ModelConfig("qwen/qwen3-next-80b-a3b-instruct:free",        max_tokens=1000, temperature=0.1,  context_window=262_144),
        "insight_evaluate":ModelConfig("qwen/qwen3-next-80b-a3b-instruct:free",        max_tokens=2500, temperature=0.0,  context_window=262_144),

        # Gemma 4 31B — Quality instruction-following writing (Google, cross-vendor)
        # ABSA uses this model via insight_narrate — dev free-tier tuning: concurrency=3, batch=10, cap=100
        "insight_narrate": ModelConfig("google/gemma-4-31b-it:free",                   max_tokens=800,  temperature=0.1,  context_window=262_144, absa_concurrency=3,  absa_batch_size=10, absa_cap=100),
        "crystal":         ModelConfig("google/gemma-4-31b-it:free",                   max_tokens=800,  temperature=0.3,  context_window=262_144),
        "report_headline": ModelConfig("google/gemma-4-31b-it:free",                   max_tokens=4000, temperature=0.1,  context_window=262_144),

        # Kimi K2.6 — Long-context synthetic response generation
        "response_gen":    ModelConfig("moonshotai/kimi-k2.6:free",                    max_tokens=8000, temperature=0.7,  context_window=262_144),

        # NVIDIA Nemotron Nano — Smallest/fastest for tiny-output verification
        "insight_verify":  ModelConfig("nvidia/nemotron-nano-9b-v2:free",              max_tokens=300,  temperature=0.0,  context_window=128_000),
        "crystal_eval":    ModelConfig("nvidia/nemotron-nano-9b-v2:free",              max_tokens=500,  temperature=0.0,  context_window=128_000),

        # Qwen3 Coder — Structured JSON output (skip-logic branching rules, QA scoring)
        # skip-logic outputs the FULL questions array with logic added — needs same budget as survey-creator
        "skip-logic":      ModelConfig("qwen/qwen3-coder:free",                        max_tokens=4000, temperature=0.1,  context_window=1_048_576),
        "survey_bias":     ModelConfig("qwen/qwen3-coder:free",                        max_tokens=800,  temperature=0.0,  context_window=1_048_576),
        "survey_evaluate": ModelConfig("qwen/qwen3-coder:free",                        max_tokens=600,  temperature=0.0,  context_window=1_048_576),
    },

    # ── dev-paid ─────────────────────────────────────────────────────────────────
    # DeepSeek v4 Flash for all reasoning/creator/report roles — replaces o3-mini/o4-mini.
    # DeepSeek v4 Flash: ~$0.20/1M in, $0.80/1M out. Better XM domain knowledge than OpenAI.
    # Gemini 2.5 Flash for cross-vendor QC, writing, and interactive copilot ($0.15/1M).
    # Gemini 2.0 Flash for fast structured validators + ABSA ($0.10/1M).
    # crystal moved from Gemini (Tier B) to DeepSeek (Tier A) 2026-08 — product request
    # for more headroom on citations/suggestions/action_proposals; context_window drops
    # from Gemini's 1M to DeepSeek's 128K for this role (see module docstring).
    #
    # Tier | Model                        $/1M in  $/1M out  Used for
    # ─────┼───────────────────────────────────────────────────────────────────
    #  A   | deepseek/deepseek-v4-flash   $0.20    $0.80     creator, topics, expert, reports, crystal
    #  B   | google/gemini-2.5-flash      $0.15    $0.60     QC, writing, copilot, QA
    #  C   | google/gemini-2.5-flash      $0.10    $0.40     verify, evaluate, ABSA, validators
    #
    # ~$0.008–0.025 per full orchestration run (3–4× cheaper than prior o3-mini/o4-mini setup).
    "dev-paid": {
        # Tier A — DeepSeek v4 Flash: reasoning for creator + topic discovery + reports
        "creator":         ModelConfig("deepseek/deepseek-v4-flash", max_tokens=6000,  temperature=0.3,  context_window=128_000),
        "insight_topics":  ModelConfig("deepseek/deepseek-v4-flash", max_tokens=8000,  temperature=0.0,  context_window=128_000),
        "insight_expert":  ModelConfig("deepseek/deepseek-v4-flash", max_tokens=2000,  temperature=0.1,  context_window=128_000),
        "report_summary":  ModelConfig("deepseek/deepseek-v4-flash", max_tokens=12000, temperature=0.1,  context_window=128_000),
        "report_full":     ModelConfig("deepseek/deepseek-v4-flash", max_tokens=60000, temperature=0.0,  context_window=128_000),
        # Crystal Q&A — doubled max_tokens (1500→3000) for citations/suggestions/action_proposals
        # headroom; the answer text itself stays 2-5 sentences (unchanged, see CrystalOutput/SKILL.md).
        "crystal":         ModelConfig("deepseek/deepseek-v4-flash", max_tokens=3000,  temperature=0.3,  context_window=128_000),

        # Tier B — Gemini 2.5 Flash: cross-vendor QC + writing + interactive (1M ctx)
        "qc":              ModelConfig("google/gemini-2.5-flash",    max_tokens=1000,  temperature=0.1,  context_window=1_000_000),
        "qc_validator":    ModelConfig("google/gemini-2.5-flash",    max_tokens=400,   temperature=0.1,  context_window=1_000_000),
        "compliance":      ModelConfig("google/gemini-2.5-flash",    max_tokens=600,   temperature=0.1,  context_window=1_000_000),
        "recommender":     ModelConfig("google/gemini-2.5-flash",    max_tokens=600,   temperature=0.4,  context_window=1_000_000),
        # skip-logic outputs full questions array — needs 4000 tokens, same as survey-creator
        "skip-logic":      ModelConfig("google/gemini-2.5-flash",    max_tokens=4000,  temperature=0.1,  context_window=1_000_000),
        "report_headline": ModelConfig("google/gemini-2.5-flash",    max_tokens=5000,  temperature=0.1,  context_window=1_000_000),
        "copilot":         ModelConfig("google/gemini-2.5-flash",    max_tokens=3000,  temperature=0.3,  context_window=1_000_000),
        "response_gen":    ModelConfig("google/gemini-2.5-flash",    max_tokens=12000,  temperature=0.8,  context_window=1_000_000),

        # Tier C — Gemini 2.0 Flash: fast structured validators + ABSA
        # absa_concurrency=5, batch=25, cap=250 for dev-paid throughput
        "insight_narrate": ModelConfig("google/gemini-2.5-flash",   max_tokens=1200,  temperature=0.1,  context_window=1_000_000, absa_concurrency=5, absa_batch_size=25, absa_cap=250),
        "insight_verify":  ModelConfig("google/gemini-2.5-flash",   max_tokens=400,   temperature=0.0,  context_window=1_000_000),
        "insight_evaluate":ModelConfig("google/gemini-2.5-flash",   max_tokens=2500,  temperature=0.0,  context_window=1_000_000),
        "crystal_eval":    ModelConfig("google/gemini-2.5-flash",   max_tokens=600,   temperature=0.0,  context_window=1_000_000),
        "survey_bias":     ModelConfig("google/gemini-2.5-flash",   max_tokens=1000,  temperature=0.0,  context_window=1_000_000),
        "survey_evaluate": ModelConfig("google/gemini-2.5-flash",   max_tokens=800,   temperature=0.0,  context_window=1_000_000),
    },

    # ── staging ──────────────────────────────────────────────────────────────────
    # DeepSeek v4 Pro for all reasoning-heavy roles — upgraded from R1.
    # v4 Pro: stronger reasoning, better XM domain knowledge, 128K ctx, ~$1.10/1M in.
    # Gemini 2.5 Flash for QC, narration, writing ($0.15/1M, 1M ctx).
    # Gemini 2.0 Flash for fast validators + ABSA ($0.10/1M).
    # Qwen 2.5 72B for advisory roles ($0.90/1M, multilingual XM expertise).
    # crystal moved from Gemini (Tier B) to DeepSeek Pro (Tier A) 2026-08 — same rationale
    # as dev-paid (product request for citation/action_proposal headroom); this is the
    # "all high-reasoning roles" upgrade this env's docstring already calls for.
    # context_window drops from Gemini's 1M to DeepSeek's 128K for this role.
    #
    # Tier | Model                          $/1M in   $/1M out  Used for
    # ─────┼────────────────────────────────────────────────────────────────────
    #  A   | deepseek/deepseek-v4-pro       $1.10     $4.40     creator, topics, expert, reports, crystal
    #  B   | google/gemini-2.5-flash        $0.15     $0.60     QC, narrate, writing
    #  C   | google/gemini-2.5-flash      $0.10     $0.40     verify, evaluate, ABSA, validators
    #  D   | qwen/qwen-2.5-72b-instruct     $0.90     $0.90     recommender, cross-vendor advisory
    #
    # ~$0.025–0.060 per full pipeline run. OPENROUTER_API_KEY required.
    "staging": {
        # Tier A — DeepSeek v4 Pro: best reasoning for complex XM tasks
        "creator":         ModelConfig("deepseek/deepseek-v4-pro", max_tokens=6000,  temperature=0.3, context_window=128_000),
        "insight_topics":  ModelConfig("deepseek/deepseek-v4-pro", max_tokens=8000,  temperature=0.0, context_window=128_000),
        "insight_expert":  ModelConfig("deepseek/deepseek-v4-pro", max_tokens=2000,  temperature=0.1, context_window=128_000),
        "report_summary":  ModelConfig("deepseek/deepseek-v4-pro", max_tokens=12000, temperature=0.1, context_window=128_000),
        "report_full":     ModelConfig("deepseek/deepseek-v4-pro", max_tokens=60000, temperature=0.0, context_window=128_000),
        # Crystal Q&A — doubled max_tokens (1500→3000) for citations/suggestions/action_proposals
        # headroom; the answer text itself stays 2-5 sentences (unchanged, see CrystalOutput/SKILL.md).
        "crystal":         ModelConfig("deepseek/deepseek-v4-pro", max_tokens=3000,  temperature=0.3, context_window=128_000),

        # Cross-vendor QC (Gemini vs DeepSeek creator — enforces vendor diversity)
        "qc":              ModelConfig("google/gemini-2.5-flash",  max_tokens=1000,  temperature=0.1, context_window=1_000_000),
        "qc_validator":    ModelConfig("google/gemini-2.5-flash",  max_tokens=400,   temperature=0.2, context_window=1_000_000),

        # Tier B — Gemini 2.5 Flash: QC, narration, writing
        "compliance":      ModelConfig("google/gemini-2.5-flash",  max_tokens=600,   temperature=0.1, context_window=1_000_000),
        # skip-logic outputs full questions array — needs 4000 tokens, same as survey-creator
        "skip-logic":      ModelConfig("google/gemini-2.5-flash",  max_tokens=4000,  temperature=0.1, context_window=1_000_000),
        "copilot":         ModelConfig("google/gemini-2.5-flash",  max_tokens=2000,  temperature=0.3, context_window=1_000_000),
        "response_gen":    ModelConfig("google/gemini-2.5-flash",  max_tokens=12000,  temperature=0.8, context_window=1_000_000),
        "report_headline": ModelConfig("google/gemini-2.5-flash",  max_tokens=5000,  temperature=0.1, context_window=1_000_000),

        # ABSA via insight_narrate — staging: concurrency=8, batch=25, cap=500
        "insight_narrate": ModelConfig("google/gemini-2.5-flash",  max_tokens=2000,  temperature=0.1, context_window=1_000_000, absa_concurrency=8, absa_batch_size=25, absa_cap=500),

        # Tier C — Gemini 2.0 Flash: fast validators + ABSA
        "insight_verify":  ModelConfig("google/gemini-2.5-flash",  max_tokens=400,   temperature=0.0, context_window=1_000_000),
        "insight_evaluate":ModelConfig("google/gemini-2.5-flash",  max_tokens=2500,  temperature=0.0, context_window=1_000_000),
        "crystal_eval":    ModelConfig("google/gemini-2.5-flash",  max_tokens=600,   temperature=0.0, context_window=1_000_000),

        # Tier D — Qwen 2.5 72B: cross-vendor advisory + multilingual XM
        "recommender":     ModelConfig("qwen/qwen-2.5-72b-instruct", max_tokens=800, temperature=0.4, context_window=32_000),
        "survey_bias":     ModelConfig("qwen/qwen-2.5-72b-instruct", max_tokens=1000, temperature=0.0, context_window=32_000),
        "survey_evaluate": ModelConfig("qwen/qwen-2.5-72b-instruct", max_tokens=800,  temperature=0.0, context_window=32_000),
    },

    # ── prod ─────────────────────────────────────────────────────────────────────
    # DeepSeek v4 Pro for all high-reasoning roles — upgraded from R1.
    # v4 Pro: next-gen reasoning, better XM domain alignment, comparable cost.
    # Gemini 2.5 Flash for synthesis, QC (1M ctx, $0.15/1M).
    # Gemini 2.0 Flash for fast validators + ABSA ($0.10/1M).
    # Qwen 2.5 72B for cross-vendor advisory roles ($0.90/1M, multilingual XM).
    # ~$0.040–0.100/run (with full 12-advisor skill system).
    # OPENROUTER_API_KEY required. ANTHROPIC_API_KEY NOT required.
    # crystal moved from Gemini to DeepSeek Pro 2026-08 (product request — headroom for
    # citations/suggestions/action_proposals; NOT for the viz chart, which is built by
    # deterministic post-LLM Python and costs no tokens). context_window drops from
    # Gemini's 1M to DeepSeek's 128K for this role — see module docstring for the tradeoff.
    "prod": {
        "creator":         ModelConfig(
            "deepseek/deepseek-v4-pro",    # Best reasoning for survey design — $1.10/1M
            max_tokens=8000,               # Large output for complex multi-section surveys
            temperature=0.3,
            context_window=128_000,
        ),
        "qc":              ModelConfig(
            "google/gemini-2.5-flash",     # Cross-vendor from DeepSeek — $0.15/1M
            max_tokens=1000,
            temperature=0.1,
            context_window=1_000_000,
        ),
        "qc_validator":    ModelConfig(
            "google/gemini-2.5-flash",
            max_tokens=400,
            temperature=0.2,
            context_window=1_000_000,
        ),
        "compliance":      ModelConfig(
            "google/gemini-2.5-flash",
            max_tokens=600,
            temperature=0.1,
            context_window=1_000_000,
        ),
        "recommender":     ModelConfig(
            "qwen/qwen-2.5-72b-instruct",  # Multilingual XM expertise — $0.90/1M
            max_tokens=800,
            temperature=0.4,
            context_window=32_000,
        ),
        # skip-logic outputs full questions array — needs 4000 tokens, same as survey-creator
        "skip-logic":      ModelConfig(
            "google/gemini-2.5-flash",
            max_tokens=4000,
            temperature=0.1,
            context_window=1_000_000,
        ),
        "copilot":         ModelConfig(
            "google/gemini-2.5-flash",
            max_tokens=2000,
            temperature=0.3,
            context_window=1_000_000,
        ),
        # ABSA uses this model via insight_narrate — prod tuning: concurrency=10, batch=50, cap=1000
        "insight_narrate": ModelConfig(
            "google/gemini-2.5-flash",     # Multilingual XM narrative quality — $0.15/1M
            max_tokens=2000,
            temperature=0.1,
            context_window=1_000_000,
            absa_concurrency=10,
            absa_batch_size=50,
            absa_cap=1000,
        ),
        "insight_verify":  ModelConfig(
            "google/gemini-2.5-flash", # Fastest structured verifier — $0.10/1M
            max_tokens=400,
            temperature=0.0,
            context_window=1_000_000,
        ),
        "insight_topics":  ModelConfig(
            "deepseek/deepseek-v4-pro",    # CX topic pattern recognition — $1.10/1M
            max_tokens=8000,
            temperature=0.0,
            context_window=128_000,
        ),
        "crystal":         ModelConfig(
            "deepseek/deepseek-v4-pro",    # XM Q&A — DeepSeek reasoning tier — $1.10/1M
            max_tokens=3000,               # doubled (1500→3000): headroom for citations/
                                            # suggestions/action_proposals; answer itself
                                            # stays 2-5 sentences (CrystalOutput contract).
            temperature=0.3,
            context_window=128_000,        # DeepSeek's documented ctx — down from Gemini's
                                            # 1M for this role; accepted, see module docstring.
        ),
        "response_gen":    ModelConfig(
            "google/gemini-2.5-flash",     # Diverse XM persona generation — $0.15/1M
            max_tokens=12000,
            temperature=0.8,
            context_window=1_000_000,
        ),
        "insight_expert":  ModelConfig("deepseek/deepseek-v4-pro", max_tokens=2000, temperature=0.1, context_window=128_000),  # Domain NPS/CSAT/CX reasoning
        "insight_evaluate":ModelConfig("google/gemini-2.5-flash", max_tokens=2500, temperature=0.0, context_window=1_000_000),  # Larger set audit for 50-response surveys
        "crystal_eval":    ModelConfig("google/gemini-2.5-flash", max_tokens=600,  temperature=0.0, context_window=1_000_000),  # Fast hallucination check
        "survey_bias":     ModelConfig("qwen/qwen-2.5-72b-instruct", max_tokens=1000, temperature=0.0, context_window=32_000),  # Cross-vendor advisory
        "survey_evaluate": ModelConfig("qwen/qwen-2.5-72b-instruct", max_tokens=800,  temperature=0.0, context_window=32_000),  # Cross-vendor advisory

        # Tiered report agents (prod: DeepSeek R1 full report, Gemini 2.5 Flash for headline/summary)
        # report_full token budget increased — larger context: prior insights + all new response texts
        "report_headline": ModelConfig("google/gemini-2.5-flash",      max_tokens=5000,  temperature=0.1, context_window=1_000_000),
        "report_summary":  ModelConfig("deepseek/deepseek-v4-pro", max_tokens=12000, temperature=0.1, context_window=128_000),
        "report_full":     ModelConfig("deepseek/deepseek-v4-pro", max_tokens=60000, temperature=0.0, context_window=128_000),
    },
}

# Per-run hard token cap: protects against runaway LLM loops.
# Increased for larger report context: report_full (60K) + topics (8K) + narrate (5×800) + ABSA batches.
MAX_TOKENS_PER_RUN: int = int(os.getenv("MAX_TOKENS_PER_RUN", "200000"))

# Per-org daily spend cap in USD (0 = disabled)
MAX_DAILY_SPEND_USD: float = float(os.getenv("MAX_DAILY_SPEND_USD", "0"))


# ── CrystalOS Skill Model Routing ─────────────────────────────────────────────
#
# Maps skill names to ModelConfig per environment.
# Each model is chosen by: quality for the task × cost × context window needed.
#
# Design principles:
#   - Complex reasoning skills (insight-narrator, action-recommender, crystal-analyst)
#     → DeepSeek v4 Pro (prod) / v4 Flash (dev-paid)
#   - XM writing + instruction following → Gemini 2.5 Flash (best multilingual, 1M ctx)
#   - Fast structured validators → Gemini 2.0 Flash (cheapest, 1M ctx)
#   - Domain advisory + APAC XM → Qwen 2.5 72B (strong XM knowledge, cost-efficient)
#   - Cross-vendor QC (survey-qc, compliance-scanner) → Gemini (opposite of creator=DeepSeek)
#   - Dev free tier → keep existing pools (unchanged from pipeline routing above)
#
# Token budgets are set based on typical output size + 20% buffer:
#   insight-narrator:  ~2000-2500 tokens (5 findings + summary + 4 actions)
#   action-recommender: ~800-1000 tokens (5 de-duplicated actions + summary)
#   specialist-*:      ~800-1000 tokens (headline + narrative + analysis + recs)
#   action advisors:   ~600-800 tokens (2-4 actions with params)
#   survey-creator:    ~3000-4000 tokens (8-12 questions with schemas)
#   copilot/refiner:   ~1500-2000 tokens (full questions array + changes)
#   crystal-analyst:   ~2400 tokens (answer [2-5 sentences, unchanged] + citations +
#                      suggestions + action_proposals headroom — doubled from ~1200 on
#                      2026-08 product request; answer length itself is not the target)
#   survey-qc:         ~600-800 tokens (qc_score + issues + improvements)
#   compliance:        ~800-1000 tokens (issues + recommendations)

_SKILL_ROUTING: dict[str, dict[str, ModelConfig]] = {

    # ── dev (free) ──────────────────────────────────────────────────────────────
    # Same free pools as pipeline routing — don't change free tier models.
    # OSS-120B for reasoning; Gemma for writing; Qwen Coder for JSON.
    "dev": {
        # Reasoning-heavy skills
        "insight-narrator":          ModelConfig("google/gemma-4-31b-it:free",              max_tokens=4000, temperature=0.1, context_window=262_144),
        "action-recommender":        ModelConfig("qwen/qwen3-next-80b-a3b-instruct:free",   max_tokens=1000, temperature=0.0, context_window=262_144),
        "crystal-analyst":           ModelConfig("google/gemma-4-31b-it:free",              max_tokens=1200, temperature=0.3, context_window=262_144),

        # Metric specialists (XM domain)
        "specialist-nps":            ModelConfig("qwen/qwen3-coder:free",                   max_tokens=1000, temperature=0.1, context_window=1_048_576),
        "specialist-ces":            ModelConfig("qwen/qwen3-coder:free",                   max_tokens=1000, temperature=0.1, context_window=1_048_576),
        "specialist-csat":           ModelConfig("qwen/qwen3-coder:free",                   max_tokens=1000, temperature=0.1, context_window=1_048_576),
        "specialist-enps":           ModelConfig("qwen/qwen3-coder:free",                   max_tokens=1000, temperature=0.1, context_window=1_048_576),
        "specialist-custom":         ModelConfig("qwen/qwen3-coder:free",                   max_tokens=1000, temperature=0.1, context_window=1_048_576),

        # Action advisors (all use fast structured JSON)
        "nps-action-advisor":        ModelConfig("qwen/qwen3-coder:free",                   max_tokens=800,  temperature=0.1, context_window=1_048_576),
        "ces-action-advisor":        ModelConfig("qwen/qwen3-coder:free",                   max_tokens=800,  temperature=0.1, context_window=1_048_576),
        "csat-action-advisor":       ModelConfig("qwen/qwen3-coder:free",                   max_tokens=800,  temperature=0.1, context_window=1_048_576),
        "enps-action-advisor":       ModelConfig("qwen/qwen3-coder:free",                   max_tokens=800,  temperature=0.1, context_window=1_048_576),
        "close-the-loop-advisor":    ModelConfig("qwen/qwen3-coder:free",                   max_tokens=800,  temperature=0.0, context_window=1_048_576),
        "predictive-action-advisor": ModelConfig("qwen/qwen3-coder:free",                   max_tokens=800,  temperature=0.0, context_window=1_048_576),

        # Strategic advisors (lighter output)
        "survey-improvement-advisor":ModelConfig("openai/gpt-oss-20b:free",                 max_tokens=1600, temperature=0.1, context_window=128_000),
        "distribution-strategist":   ModelConfig("openai/gpt-oss-20b:free",                 max_tokens=800,  temperature=0.2, context_window=128_000),
        "benchmark-strategist":      ModelConfig("openai/gpt-oss-20b:free",                 max_tokens=700,  temperature=0.1, context_window=128_000),
        "voc-program-advisor":       ModelConfig("openai/gpt-oss-20b:free",                 max_tokens=700,  temperature=0.1, context_window=128_000),
        "segment-action-advisor":    ModelConfig("openai/gpt-oss-20b:free",                 max_tokens=700,  temperature=0.1, context_window=128_000),
        "journey-advisor":           ModelConfig("openai/gpt-oss-20b:free",                 max_tokens=700,  temperature=0.1, context_window=128_000),

        # Survey design skills (creative + instruction following)
        "survey-creator":            ModelConfig("openai/gpt-oss-120b:free",                max_tokens=4000, temperature=0.3, context_window=128_000),
        "copilot-analyst":           ModelConfig("google/gemma-4-31b-it:free",              max_tokens=2000, temperature=0.2, context_window=262_144),
        "survey-refiner":            ModelConfig("google/gemma-4-31b-it:free",              max_tokens=2000, temperature=0.2, context_window=262_144),
        "survey-recommender":        ModelConfig("qwen/qwen3-coder:free",                   max_tokens=800,  temperature=0.2, context_window=1_048_576),

        # QC + compliance (cross-vendor: QC=Qwen vs creator=OSS)
        "survey-qc":                 ModelConfig("qwen/qwen3-next-80b-a3b-instruct:free",   max_tokens=800,  temperature=0.0, context_window=262_144),
        "compliance-scanner":        ModelConfig("qwen/qwen3-next-80b-a3b-instruct:free",   max_tokens=1000, temperature=0.0, context_window=262_144),
    },

    # ── dev-paid ────────────────────────────────────────────────────────────────
    # DeepSeek v4 Flash for complex reasoning/domain tasks, incl. crystal-analyst (2026-08).
    # Gemini 2.5 Flash for writing, QC, and interactive skills.
    # Gemini 2.0 Flash for fast structured output validators.
    # ~$0.003–0.012 per skill execution.
    "dev-paid": {
        # DeepSeek v4 Flash: reasoning-heavy skills ($0.20/1M in, $0.80/1M out)
        "insight-narrator":          ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=4000, temperature=0.1, context_window=128_000),
        "action-recommender":        ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=1000, temperature=0.0, context_window=128_000),
        "specialist-nps":            ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=1000, temperature=0.1, context_window=128_000),
        "specialist-ces":            ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=1000, temperature=0.1, context_window=128_000),
        "specialist-csat":           ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=1000, temperature=0.1, context_window=128_000),
        "specialist-enps":           ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=1000, temperature=0.1, context_window=128_000),
        "specialist-custom":         ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=1000, temperature=0.1, context_window=128_000),
        "nps-action-advisor":        ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.1, context_window=128_000),
        "ces-action-advisor":        ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.1, context_window=128_000),
        "csat-action-advisor":       ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.1, context_window=128_000),
        "enps-action-advisor":       ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.1, context_window=128_000),
        "close-the-loop-advisor":    ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.0, context_window=128_000),
        "predictive-action-advisor": ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.0, context_window=128_000),
        "survey-creator":            ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=4000, temperature=0.3, context_window=128_000),
        # crystal-analyst — moved off Gemini (was 1200 tok / 1M ctx) 2026-08 for reasoning
        # headroom on citations/suggestions/action_proposals; DeepSeek's 128K ctx replaces
        # Gemini's 1M for this skill (tradeoff — see module docstring).
        "crystal-analyst":           ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=2400, temperature=0.3, context_window=128_000),

        # Gemini 2.5 Flash: writing, QC, interactive, 1M ctx ($0.15/1M in, $0.60/1M out)
        "copilot-analyst":           ModelConfig("google/gemini-2.5-flash",                 max_tokens=2000, temperature=0.2, context_window=1_000_000),
        "survey-refiner":            ModelConfig("google/gemini-2.5-flash",                 max_tokens=2000, temperature=0.2, context_window=1_000_000),
        "survey-qc":                 ModelConfig("google/gemini-2.5-flash",                 max_tokens=800,  temperature=0.0, context_window=1_000_000),  # cross-vendor: QC≠creator
        "compliance-scanner":        ModelConfig("google/gemini-2.5-flash",                 max_tokens=1000, temperature=0.0, context_window=1_000_000),
        "survey-recommender":        ModelConfig("google/gemini-2.5-flash",                 max_tokens=800,  temperature=0.2, context_window=1_000_000),

        # Gemini 2.0 Flash: fast strategic advisors ($0.10/1M in, $0.40/1M out)
        "survey-improvement-advisor":ModelConfig("google/gemini-2.5-flash",                 max_tokens=1600, temperature=0.1, context_window=1_000_000),
        "distribution-strategist":   ModelConfig("google/gemini-2.5-flash",                 max_tokens=800,  temperature=0.2, context_window=1_000_000),
        "benchmark-strategist":      ModelConfig("google/gemini-2.5-flash",                 max_tokens=700,  temperature=0.1, context_window=1_000_000),
        "voc-program-advisor":       ModelConfig("google/gemini-2.5-flash",                 max_tokens=700,  temperature=0.1, context_window=1_000_000),
        "segment-action-advisor":    ModelConfig("google/gemini-2.5-flash",                 max_tokens=700,  temperature=0.1, context_window=1_000_000),
        "journey-advisor":           ModelConfig("google/gemini-2.5-flash",                 max_tokens=700,  temperature=0.1, context_window=1_000_000),
    },

    # ── staging ─────────────────────────────────────────────────────────────────
    # DeepSeek v4 Pro for complex XM reasoning ($1.10/1M in, $4.40/1M out), incl.
    # crystal-analyst (2026-08 — moved off Gemini for citation/action_proposal headroom).
    # Gemini 2.5 Flash for multilingual writing, QC ($0.15/1M, 1M ctx).
    # DeepSeek v4 Flash for fast advisory skills ($0.20/1M — cost vs quality sweet spot).
    # Qwen 2.5 72B for cross-vendor advisory roles ($0.90/1M, strong XM domain).
    "staging": {
        # DeepSeek v4 Pro: high-stakes reasoning + insight generation
        "insight-narrator":          ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=4000, temperature=0.1, context_window=128_000),
        "action-recommender":        ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=1000, temperature=0.0, context_window=128_000),
        "specialist-nps":            ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=1000, temperature=0.1, context_window=128_000),
        "specialist-ces":            ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=1000, temperature=0.1, context_window=128_000),
        "specialist-csat":           ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=1000, temperature=0.1, context_window=128_000),
        "specialist-enps":           ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=1000, temperature=0.1, context_window=128_000),
        "specialist-custom":         ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=1000, temperature=0.1, context_window=128_000),
        "survey-creator":            ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=4000, temperature=0.3, context_window=128_000),
        # crystal-analyst — moved off Gemini (was 1200 tok / 1M ctx) 2026-08; DeepSeek's
        # 128K ctx replaces Gemini's 1M for this skill (tradeoff — see module docstring).
        "crystal-analyst":           ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=2400, temperature=0.3, context_window=128_000),

        # Gemini 2.5 Flash: multilingual writing, QC (1M ctx)
        "copilot-analyst":           ModelConfig("google/gemini-2.5-flash",                 max_tokens=2000, temperature=0.2, context_window=1_000_000),
        "survey-refiner":            ModelConfig("google/gemini-2.5-flash",                 max_tokens=2000, temperature=0.2, context_window=1_000_000),
        "survey-qc":                 ModelConfig("google/gemini-2.5-flash",                 max_tokens=800,  temperature=0.0, context_window=1_000_000),  # cross-vendor: QC≠DeepSeek creator
        "compliance-scanner":        ModelConfig("google/gemini-2.5-flash",                 max_tokens=1000, temperature=0.0, context_window=1_000_000),
        "survey-recommender":        ModelConfig("google/gemini-2.5-flash",                 max_tokens=800,  temperature=0.2, context_window=1_000_000),

        # DeepSeek v4 Flash: fast advisory skills ($0.20/1M — cost-optimised)
        "nps-action-advisor":        ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.1, context_window=128_000),
        "ces-action-advisor":        ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.1, context_window=128_000),
        "csat-action-advisor":       ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.1, context_window=128_000),
        "enps-action-advisor":       ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.1, context_window=128_000),
        "close-the-loop-advisor":    ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.0, context_window=128_000),
        "predictive-action-advisor": ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.0, context_window=128_000),
        "survey-improvement-advisor":ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=1600, temperature=0.1, context_window=128_000),
        "distribution-strategist":   ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.2, context_window=128_000),
        "benchmark-strategist":      ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=700,  temperature=0.1, context_window=128_000),
        "voc-program-advisor":       ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=700,  temperature=0.1, context_window=128_000),
        "segment-action-advisor":    ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=700,  temperature=0.1, context_window=128_000),
        "journey-advisor":           ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=700,  temperature=0.1, context_window=128_000),
    },

    # ── prod ────────────────────────────────────────────────────────────────────
    # Same as staging with higher token budgets for edge cases.
    # DeepSeek v4 Pro: flagship reasoning for insight generation + specialists + Crystal
    # (crystal-analyst moved off Gemini 2026-08 — product request for citation/
    # action_proposal headroom; NOT for the viz chart, which is deterministic Python
    # built after the LLM call and costs no tokens — see module docstring).
    # Gemini 2.5 Flash: production QC, writing, copilot (1M ctx, battle-tested).
    # DeepSeek v4 Flash: all 12 advisory specialists (cost-optimised advisory tier).
    # Qwen 2.5 72B: survey-recommender (APAC XM knowledge + cost-efficient).
    # ~$0.040–0.100/run at full pipeline + 12 advisors.
    "prod": {
        # DeepSeek v4 Pro: flagship insight + specialist tier
        "insight-narrator":          ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=4000, temperature=0.1, context_window=128_000),
        "action-recommender":        ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=1000, temperature=0.0, context_window=128_000),
        "specialist-nps":            ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=1000, temperature=0.1, context_window=128_000),
        "specialist-ces":            ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=1000, temperature=0.1, context_window=128_000),
        "specialist-csat":           ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=1000, temperature=0.1, context_window=128_000),
        "specialist-enps":           ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=1000, temperature=0.1, context_window=128_000),
        "specialist-custom":         ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=1000, temperature=0.1, context_window=128_000),
        "survey-creator":            ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=4500, temperature=0.3, context_window=128_000),
        # crystal-analyst — moved off Gemini (was 1200 tok / 1M ctx) 2026-08; DeepSeek's
        # 128K ctx replaces Gemini's 1M for this skill (tradeoff — see module docstring).
        "crystal-analyst":           ModelConfig("deepseek/deepseek-v4-pro",                max_tokens=2400, temperature=0.3, context_window=128_000),

        # Gemini 2.5 Flash: production QC, writing, copilot
        "copilot-analyst":           ModelConfig("google/gemini-2.5-flash",                 max_tokens=2000, temperature=0.2, context_window=1_000_000),
        "survey-refiner":            ModelConfig("google/gemini-2.5-flash",                 max_tokens=2000, temperature=0.2, context_window=1_000_000),
        "survey-qc":                 ModelConfig("google/gemini-2.5-flash",                 max_tokens=800,  temperature=0.0, context_window=1_000_000),  # cross-vendor: QC≠DeepSeek creator
        "compliance-scanner":        ModelConfig("google/gemini-2.5-flash",                 max_tokens=1000, temperature=0.0, context_window=1_000_000),

        # Qwen 2.5 72B: survey-recommender (strong APAC XM knowledge, multilingual)
        "survey-recommender":        ModelConfig("qwen/qwen-2.5-72b-instruct",              max_tokens=800,  temperature=0.2, context_window=32_000),

        # DeepSeek v4 Flash: all 12 advisory specialists at prod scale
        "nps-action-advisor":        ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.1, context_window=128_000),
        "ces-action-advisor":        ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.1, context_window=128_000),
        "csat-action-advisor":       ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.1, context_window=128_000),
        "enps-action-advisor":       ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.1, context_window=128_000),
        "close-the-loop-advisor":    ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.0, context_window=128_000),
        "predictive-action-advisor": ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.0, context_window=128_000),
        "survey-improvement-advisor":ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=1600, temperature=0.1, context_window=128_000),
        "distribution-strategist":   ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=800,  temperature=0.2, context_window=128_000),
        "benchmark-strategist":      ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=700,  temperature=0.1, context_window=128_000),
        "voc-program-advisor":       ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=700,  temperature=0.1, context_window=128_000),
        "segment-action-advisor":    ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=700,  temperature=0.1, context_window=128_000),
        "journey-advisor":           ModelConfig("deepseek/deepseek-v4-flash",              max_tokens=700,  temperature=0.1, context_window=128_000),
    },
}


def get_model(agent: AgentName) -> ModelConfig:
    env = get_env()
    return _ROUTING[env][agent]


def get_skill_model(skill_name: str) -> ModelConfig:
    """Return the model config for a CrystalOS skill in the current env.

    Looks up the skill name in _SKILL_ROUTING first.
    Falls back to insight_narrate if the skill is not explicitly mapped
    (safe default for any new skills added without a routing entry).

    Args:
        skill_name: The SKILL.md 'name' field (kebab-case, e.g. 'insight-narrator').

    Returns:
        ModelConfig for the current AGENTS_ENV.
    """
    env = get_env()
    skill_env_routing = _SKILL_ROUTING.get(env, {})
    if skill_name in skill_env_routing:
        return skill_env_routing[skill_name]
    # Fallback: use insight_narrate model (appropriate mid-tier default)
    return get_model("insight_narrate")


def list_skill_models() -> dict[str, str]:
    """Return {skill_name: model_id} for all mapped skills in the current env.

    Used by the /agents/registry endpoint and openrouter-scan tool to show
    which model each skill is using.
    """
    env = get_env()
    return {
        skill: cfg.model
        for skill, cfg in _SKILL_ROUTING.get(env, {}).items()
    }


def get_absa_config() -> dict:
    """Return ABSA tuning params for the current env from the insight_narrate model config."""
    cfg = get_model("insight_narrate")
    return {
        "batch_size":     cfg.absa_batch_size,
        "concurrency":    cfg.absa_concurrency,
        "cap":            cfg.absa_cap,
        "context_window": cfg.context_window,
    }


def get_env() -> EnvName:
    env = os.getenv("AGENTS_ENV", "dev")
    return env if env in _VALID_ENVS else "dev"  # type: ignore[return-value]


# ── Known-valid OpenRouter model IDs ────────────────────────────────────────
# Update this set whenever you add a new model to any routing table.
# Checked at startup by validate_all_model_configs() — an unknown model ID
# causes a ValueError so the error surfaces at deploy time, not at 2am during
# a pipeline run.
#
# To verify a new ID: https://openrouter.ai/models — search for the slug, confirm
# the exact ID shown on the model page, then add it here.
KNOWN_OPENROUTER_MODELS: frozenset[str] = frozenset({
    # DeepSeek
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    # Google
    "google/gemini-2.5-flash",
    "google/gemma-4-31b-it:free",
    # OpenAI OSS (free pool)
    "openai/gpt-oss-120b:free",
    "openai/gpt-oss-20b:free",
    # Qwen
    "qwen/qwen-2.5-72b-instruct",
    "qwen/qwen3-coder:free",
    "qwen/qwen3-next-80b-a3b-instruct:free",
    # NVIDIA
    "nvidia/nemotron-nano-9b-v2:free",
    # Moonshot
    "moonshotai/kimi-k2.6:free",
})


def validate_all_model_configs() -> None:
    """Check every routing table entry against KNOWN_OPENROUTER_MODELS.

    Raises ValueError listing all unknown model IDs so the full set of
    problems is visible in a single startup failure rather than one at a time.

    Called from main.py lifespan on startup.
    """
    unknown: list[str] = []
    for table_name, table in (("_ROUTING", _ROUTING), ("_SKILL_ROUTING", _SKILL_ROUTING)):
        for env_name, env_dict in table.items():
            for role, cfg in env_dict.items():
                if cfg.use_anthropic_sdk:
                    continue  # direct SDK calls — not an OpenRouter route
                if cfg.model not in KNOWN_OPENROUTER_MODELS:
                    unknown.append(f"  {table_name}[{env_name!r}][{role!r}] = {cfg.model!r}")
    if unknown:
        lines = "\n".join(unknown)
        raise ValueError(
            f"Unknown OpenRouter model IDs detected — add them to KNOWN_OPENROUTER_MODELS "
            f"after verifying at https://openrouter.ai/models:\n{lines}"
        )


def requires_anthropic_key() -> bool:
    """True when the current env uses Anthropic SDK for any agent.
    All envs now route through OpenRouter — this always returns False.
    Kept for backwards-compatibility with startup health checks.
    """
    return any(
        getattr(cfg, "use_anthropic_sdk", False)
        for env_dict in _ROUTING.values()
        for cfg in env_dict.values()
        if env_dict is _ROUTING.get(get_env(), {})
    )


def requires_openrouter_key() -> bool:
    """True when the current env uses OpenRouter for any agent. Always True — all envs use OpenRouter."""
    return True
