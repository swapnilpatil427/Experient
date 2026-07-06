"""Centralized constants for the Crystal Intelligence Platform.

All hardcoded thresholds, limits, and tuning values live here.
Import from this module — never hardcode these values in pipeline files.

Environment-aware constants (AGENTS_ENV):
  dev        — local development; small limits for fast iteration
  dev-paid   — development with paid LLM API; medium limits
  staging    — pre-production; near-production limits
  prod       — production; enterprise-grade limits

All per-env defaults can be overridden via environment variables.
"""
from __future__ import annotations
import os

_ENV = os.getenv("AGENTS_ENV", "dev").lower()
AGENTS_ENV = _ENV

# ── Streaming consumer ────────────────────────────────────────────────────────
METRIC_SNAPSHOT_RESPONSE_THRESHOLD = 50    # write metric snapshot every N responses
CHECKPOINT_FULL_RESPONSE_THRESHOLD = 200   # write full checkpoint blob every N responses
CHECKPOINT_FULL_MAX_DAYS = 7               # also write full checkpoint if N days have passed

# ── Response loading (environment-aware) ──────────────────────────────────────
#
# Why per-env limits matter:
#   Statistical quality:  NPS margin of error at 95% CI ≈ 1.96 × SE(NPS)
#     n=100  → MOE ≈ ±14 pts   (acceptable for quick pulse)
#     n=300  → MOE ≈ ±8 pts    (good for dev-paid)
#     n=500  → MOE ≈ ±6 pts    (good for staging)
#     n=1000 → MOE ≈ ±4 pts    (enterprise quality; Bain/Satmetrix standard)
#     n=1500 → MOE ≈ ±3 pts    (high confidence bootstrap)
#
#   Sampling note: these caps apply after stratified sampling selects
#   a representative cross-section of ALL responses, not just the most recent.
#
# Bootstrap = first run (seeds topic centroids; needs more data)
# Cap       = incremental runs (only new responses need ABSA/clustering)

if _ENV == "prod":
    _BOOTSTRAP_DEFAULT = "1500"
    _CAP_DEFAULT       = "1000"
    _ABSA_CAP_DEFAULT  = "150"
    _ANCHOR_DEFAULT    = "75"
elif _ENV == "staging":
    _BOOTSTRAP_DEFAULT = "750"
    _CAP_DEFAULT       = "500"
    _ABSA_CAP_DEFAULT  = "100"
    _ANCHOR_DEFAULT    = "50"
elif _ENV == "dev-paid":
    _BOOTSTRAP_DEFAULT = "500"
    _CAP_DEFAULT       = "300"
    _ABSA_CAP_DEFAULT  = "75"
    _ANCHOR_DEFAULT    = "30"
else:                                       # dev / local / test
    _BOOTSTRAP_DEFAULT = "100"
    _CAP_DEFAULT       = "100"
    _ABSA_CAP_DEFAULT  = "50"
    _ANCHOR_DEFAULT    = "10"

INGEST_MAX_RESPONSES_BOOTSTRAP: int = int(os.getenv("INGEST_MAX_RESPONSES_BOOTSTRAP", _BOOTSTRAP_DEFAULT))
INGEST_MAX_RESPONSES_CAP:       int = int(os.getenv("INGEST_MAX_RESPONSES_CAP",       _CAP_DEFAULT))
INGEST_NEW_RESPONSE_ABSA_CAP:   int = int(os.getenv("INGEST_NEW_RESPONSE_ABSA_CAP",   _ABSA_CAP_DEFAULT))
INGEST_ANCHOR_RESPONSES:        int = int(os.getenv("INGEST_ANCHOR_RESPONSES",        _ANCHOR_DEFAULT))

# Surveys with more total responses than this use SQL-level NTILE sampling
# (never loading all IDs into Python). Below this threshold, Python-side
# sampling is fine (< 1000 rows × ~30 bytes ≈ 30 KB).
INGEST_LARGE_SURVEY_THRESHOLD: int = int(os.getenv("INGEST_LARGE_SURVEY_THRESHOLD", "1000"))

# Dynamic bucket count: each bucket should cover a consistent calendar window
# (≈ 2 weeks) so temporal patterns are preserved at any survey length.
# Overridable via env var for testing or forced fixed-bucket deployments.
_STRATIFIED_BUCKETS_ENV: str | None = os.getenv("INGEST_STRATIFIED_BUCKETS")
_STRATIFIED_BUCKETS_OVERRIDE: int | None = (
    int(_STRATIFIED_BUCKETS_ENV) if _STRATIFIED_BUCKETS_ENV else None
)


def compute_stratified_buckets(survey_age_days: float) -> int:
    """Return the number of time buckets for proportional response sampling.

    Scales with survey duration so each bucket spans a consistent window:
      <  14 days  →  3 buckets  (~2–5 days each  — very new survey)
      <  90 days  →  6 buckets  (~2 weeks each   — typical short cycle)
      < 365 days  → 12 buckets  (~1 month each   — annual cycle)
      ≥ 365 days  → 26 buckets  (~2 weeks each   — biweekly; preserves seasonality)

    The INGEST_STRATIFIED_BUCKETS env var pins a fixed count for testing.
    Minimum of 3 is enforced regardless of age to avoid degenerate 1- or 2-bucket splits.
    """
    if _STRATIFIED_BUCKETS_OVERRIDE is not None:
        return _STRATIFIED_BUCKETS_OVERRIDE
    if survey_age_days < 14:
        return 3
    if survey_age_days < 90:
        return 6
    if survey_age_days < 365:
        return 12
    return 26

# ── Manual refresh ────────────────────────────────────────────────────────────
MANUAL_REFRESH_MIN_NEW_RESPONSES = 10      # min new responses required to allow manual refresh
MANUAL_REFRESH_MAX_DAILY = 3               # max manual refreshes per survey per day

# ── Insight Pipeline v2 — settings defaults (04 §14) ──────────────────────────
# Platform-constant fallbacks for survey_insight_settings → org_insight_defaults →
# constant COALESCE merge (see lib/insight_settings.py::load_insight_settings).
# Per-survey/per-org overrides take precedence; these are the floor.
DEFAULT_PRIOR_CHECKPOINT_LOOKBACK:        int = int(os.getenv("DEFAULT_PRIOR_CHECKPOINT_LOOKBACK",        "5"))
DEFAULT_PRIOR_CHECKPOINT_MAX_AGE_DAYS:    int = int(os.getenv("DEFAULT_PRIOR_CHECKPOINT_MAX_AGE_DAYS",    "90"))
DEFAULT_STREAM_THRESHOLD:                 int = int(os.getenv("DEFAULT_STREAM_THRESHOLD",                 "100"))
# response_tagging_batch_size (04 §14 extension, added 2026-07-04) — how many new
# response-stream events accumulate before the streaming consumer runs a lightweight
# sentiment/emotion/effort/topic tagging sweep (see lib/response_tagging.py). Separate
# from DEFAULT_STREAM_THRESHOLD, which still gates full report+checkpoint generation.
DEFAULT_RESPONSE_TAGGING_BATCH_SIZE:      int = int(os.getenv("DEFAULT_RESPONSE_TAGGING_BATCH_SIZE",      "1"))
# Safety ceiling on how many untagged responses a single tagging sweep call processes,
# independent of response_tagging_batch_size (which only controls trigger cadence).
# Keeps a large backlog sweep (scheduler catch-up, or a survey that's been silent for a
# while) from doing unbounded work in one call — mirrors INGEST_NEW_RESPONSE_ABSA_CAP.
# Env-tiered (fixed 2026-07-13, was flat 50 — inconsistent with every sibling constant in
# this section): larger in prod/staging so a real backlog drains in fewer scheduler ticks,
# smaller in dev for fast iteration and to keep local LLM-call volume low.
if _ENV == "prod":
    _RESPONSE_TAGGING_SWEEP_CAP_DEFAULT = "200"
elif _ENV == "staging":
    _RESPONSE_TAGGING_SWEEP_CAP_DEFAULT = "100"
elif _ENV == "dev-paid":
    _RESPONSE_TAGGING_SWEEP_CAP_DEFAULT = "75"
else:                                             # dev / local / test
    _RESPONSE_TAGGING_SWEEP_CAP_DEFAULT = "50"

RESPONSE_TAGGING_SWEEP_CAP: int = int(os.getenv("RESPONSE_TAGGING_SWEEP_CAP", _RESPONSE_TAGGING_SWEEP_CAP_DEFAULT))
# Circuit breaker (added 2026-07-13): a response that fails tagging this many times in a
# row gets quarantined (ai_enriched_at set with no scores) instead of being retried
# forever. Without this, a single permanently-poisoned response — malformed answers,
# a corrupted embedding, anything that reliably throws — would be re-selected by every
# future sweep's oldest-first query and block every response behind it, indefinitely.
# See lib/response_tagging.py::_record_batch_failure.
MAX_RESPONSE_TAGGING_ATTEMPTS:            int = int(os.getenv("MAX_RESPONSE_TAGGING_ATTEMPTS",            "3"))
# Candidate-buffer floor before a new topic gets clustered + LLM-named (was an
# adaptive max(5, 3% of total responses) formula inline in node_cluster; simplified to
# one flat number shared by node_cluster AND lib/response_tagging.py's lightweight
# sweep, 2026-07-04 — clustering validity doesn't scale with survey size, so going
# flat WRT survey size was correct. But this is still a cost/latency knob (how often
# we pay for an LLM topic-naming call) like every sibling in the ingest section above,
# so — fixed same day — it's env-tiered like they are, AND resolvable per survey/org
# as a real setting (see lib/insight_settings.py::resolve_topic_discovery_candidate_
# threshold); this constant is now only the platform-default floor of that resolution.
if _ENV == "prod":
    _TOPIC_DISCOVERY_CANDIDATE_DEFAULT = "30"   # matches the codebase's own n>=30 "reliable" bar
elif _ENV == "staging":
    _TOPIC_DISCOVERY_CANDIDATE_DEFAULT = "20"
elif _ENV == "dev-paid":
    _TOPIC_DISCOVERY_CANDIDATE_DEFAULT = "15"
else:                                            # dev / local / test
    _TOPIC_DISCOVERY_CANDIDATE_DEFAULT = "10"

TOPIC_DISCOVERY_CANDIDATE_THRESHOLD:      int = int(os.getenv("TOPIC_DISCOVERY_CANDIDATE_THRESHOLD",      _TOPIC_DISCOVERY_CANDIDATE_DEFAULT))
# Minimum size a candidate cluster must reach before it's promoted to a real,
# permanently-stored, LLM-named topic — separate from the buffer-count floor above,
# which only gates WHEN clustering runs, not how big the resulting cluster has to be.
# Added 2026-07-04: a flush of 25+ candidates can fragment into several 2-item
# clusters via cluster_texts's own min_cluster_size=2 default, and each one used to
# get promoted regardless — below even this codebase's own "low confidence" floor
# (n<10) elsewhere. Flat across all envs (a statistical validity floor, not a
# cost/latency knob — unlike the candidate threshold above, there's no reason a
# 2-item "topic" is more acceptable in dev than in prod). Also resolvable per
# survey/org as a real setting — see resolve_topic_discovery_min_cluster_size.
# Applies ONLY to incremental (post-bootstrap) discovery; bootstrap's exploratory
# first pass keeps cluster_texts's default of 2 — there's no established topic set
# to protect yet on a survey's very first run.
DEFAULT_TOPIC_DISCOVERY_MIN_CLUSTER_SIZE: int = int(os.getenv("DEFAULT_TOPIC_DISCOVERY_MIN_CLUSTER_SIZE", "5"))
DEFAULT_REPORT_REGEN_THRESHOLD:           int = int(os.getenv("DEFAULT_REPORT_REGEN_THRESHOLD",           "25"))
DEFAULT_FULL_CHECKPOINT_THRESHOLD:        int = int(os.getenv("DEFAULT_FULL_CHECKPOINT_THRESHOLD",        "200"))
DEFAULT_MEANINGFUL_DELTA_NPS_POINTS:    float = float(os.getenv("DEFAULT_MEANINGFUL_DELTA_NPS_POINTS",    "2.0"))
DEFAULT_MEANINGFUL_DELTA_TOPIC_PCT:     float = float(os.getenv("DEFAULT_MEANINGFUL_DELTA_TOPIC_PCT",     "10.0"))
DEFAULT_MANUAL_EXPERT_SNAPSHOTS:          int = int(os.getenv("DEFAULT_MANUAL_EXPERT_SNAPSHOTS",          "5"))
DEFAULT_MANUAL_QUICK_SAMPLE:              int = int(os.getenv("DEFAULT_MANUAL_QUICK_SAMPLE",              "150"))
DEFAULT_MANUAL_QUICK_SNAPSHOTS:           int = int(os.getenv("DEFAULT_MANUAL_QUICK_SNAPSHOTS",           "2"))
DEFAULT_MANUAL_QUICK_WINDOW_DAYS:         int = int(os.getenv("DEFAULT_MANUAL_QUICK_WINDOW_DAYS",         "14"))
DEFAULT_MANUAL_EXPERT_CHECKPOINT_LOOKBACK: int = int(os.getenv("DEFAULT_MANUAL_EXPERT_CHECKPOINT_LOOKBACK", "3"))
DEFAULT_MANUAL_EXPERT_MAX_CORPUS:         int = int(os.getenv("DEFAULT_MANUAL_EXPERT_MAX_CORPUS",         "2000"))
DEFAULT_MANUAL_EXPERT_FULL_CORPUS_CAP:    int = int(os.getenv("DEFAULT_MANUAL_EXPERT_FULL_CORPUS_CAP",    "500"))
DEFAULT_REFRESH_LOOKBACK_DAYS:            int = int(os.getenv("DEFAULT_REFRESH_LOOKBACK_DAYS",            "30"))
DEFAULT_REFRESH_MIN_RESPONSE_COUNT:       int = int(os.getenv("DEFAULT_REFRESH_MIN_RESPONSE_COUNT",       "25"))
DEFAULT_REFRESH_DAILY_LIMIT:              int = int(os.getenv("REFRESH_DAILY_LIMIT",                      "5"))
DEFAULT_MANUAL_DAILY_RUN_LIMIT:           int = int(os.getenv("MANUAL_DAILY_RUN_LIMIT",                   "10"))

# ── Insight Pipeline v2 — credit costs (04 §15) ───────────────────────────────
# Default per-run credit cost; env-overridable; per-survey/org overrides win.
CREDIT_COST_AUTOMATED_CHECKPOINT: int = int(os.getenv("CREDIT_COST_AUTOMATED_CHECKPOINT", "5"))
CREDIT_COST_AUTOMATED_REPORT:     int = int(os.getenv("CREDIT_COST_AUTOMATED_REPORT",     "15"))
CREDIT_COST_REFRESH:              int = int(os.getenv("CREDIT_COST_REFRESH",              "8"))
CREDIT_COST_MANUAL_QUICK:         int = int(os.getenv("CREDIT_COST_MANUAL_QUICK",         "15"))
CREDIT_COST_MANUAL_EXPERT:        int = int(os.getenv("CREDIT_COST_MANUAL_EXPERT",        "40"))
CREDIT_COST_CUSTOM_BASE:          int = int(os.getenv("CREDIT_COST_CUSTOM_BASE",          "25"))

# ── Insight Pipeline v2 — checkpoint v2 dual-write toggle (Phase 3 §9) ─────────
# When True, node_publish writes insight_checkpoints_v2 (with parent_checkpoint_id +
# lineage_json) IN ADDITION TO the legacy survey_insight_checkpoints write. Gates the
# Phase 1→2 migration so the legacy table stays warm during cutover.
INSIGHT_CHECKPOINTS_V2_ENABLED: bool = os.getenv("INSIGHT_CHECKPOINTS_V2_ENABLED", "true").lower() == "true"

# Phase 7: when True, skip writing to the legacy survey_insight_checkpoints table.
# Enable after all orgs have been migrated to insight_checkpoints_v2.
# Default: False (dual-write still active during migration).
STOP_LEGACY_CHECKPOINT_WRITE: bool = os.getenv("STOP_LEGACY_CHECKPOINT_WRITE", "false").lower() == "true"

# Run profiles (04 §1). automated_incremental is the default for stream/scheduler.
INSIGHT_PROFILE_AUTOMATED:     str = "automated_incremental"
INSIGHT_PROFILE_REFRESH:       str = "refresh"
INSIGHT_PROFILE_MANUAL_EXPERT: str = "manual_expert"
INSIGHT_PROFILE_MANUAL_QUICK:  str = "manual_quick"
INSIGHT_PROFILES: frozenset[str] = frozenset({
    INSIGHT_PROFILE_AUTOMATED, INSIGHT_PROFILE_REFRESH,
    INSIGHT_PROFILE_MANUAL_EXPERT, INSIGHT_PROFILE_MANUAL_QUICK,
})

# ── Topic clustering ──────────────────────────────────────────────────────────
# Nearest-centroid ASSIGNMENT (matching a response to an EXISTING topic) compares
# a raw embedding against a Welford running-mean centroid averaged over many prior
# examples — low noise, and cheap to get wrong (just nudges an already-vetted
# topic's centroid). New-topic DISCOVERY (forming a brand-new cluster from raw
# individual embeddings) is noisier and expensive to get wrong — it mints a
# permanent, LLM-named, customer-visible topic. These used to share one threshold
# (both 0.72, by coincidence of one constant's value); split 2026-07-04 so
# discovery can be more conservative than assignment, matching each operation's
# actual error cost.
TOPIC_ASSIGNMENT_THRESHOLD = 0.72          # cosine similarity threshold for topic assignment
TOPIC_DISCOVERY_SIMILARITY_THRESHOLD = 0.80  # incremental (post-bootstrap) new-cluster formation only;
                                              # bootstrap's exploratory first pass stays on TOPIC_ASSIGNMENT_THRESHOLD
WINDOW_MIN_RESPONSES = {                   # min responses needed per window
    "all_time": 1,
    "last_30d": 10,
    "last_7d": 5,
}
TOPIC_CONFIDENCE_LOW = 0.5                 # below this: low confidence
TOPIC_CONFIDENCE_MEDIUM = 0.65             # below this: medium confidence
TOPIC_CONFIDENCE_HIGH = 0.80               # above this: high confidence

# ── Trust score ───────────────────────────────────────────────────────────────
TRUST_STATISTICAL_MODERATE_MIN = 30        # min responses for moderate statistical trust
TRUST_STATISTICAL_HIGH_MIN = 100           # min responses for high statistical trust (was 50)
TRUST_LOW_MAX = 40                         # trust score ≤ this → low
TRUST_MEDIUM_MAX = 70                      # trust score ≤ this → medium
TRUST_HIGH_MAX = 100                       # trust score ≤ this → high

# ── Prior insight context (incremental narration) ────────────────────────────
# When generating a new report, carry forward high-confidence findings from the
# last run as "established context" so new narration builds on prior knowledge.
#
# Selection strategy: prefer high-confidence (trust ≥ PRIOR_MIN_TRUST), then
# fill remaining slots with the best available if not enough high-confidence ones exist.
# This ensures the LLM always gets N items of prior context regardless of run history.
PRIOR_INSIGHT_MIN_TRUST: int    = int(os.getenv("PRIOR_INSIGHT_MIN_TRUST",    "65"))
PRIOR_INSIGHT_MAX_COUNT: int    = int(os.getenv("PRIOR_INSIGHT_MAX_COUNT",     "8"))
PRIOR_INSIGHT_LAYERS: tuple     = ("prescriptive", "diagnostic")   # most actionable layers

# ── Full report generation ─────────────────────────────────────────────────────
# Controls what goes into the full report context window.
# The report LLM receives: established insights + new response texts + computed metrics.
# All parameters are tunable — increase for higher accuracy at higher cost.
#
# REPORT_PRIOR_MIN_TRUST:      minimum trust score to include a prior insight as "established"
# REPORT_PRIOR_MAX_INSIGHTS:   max prior insights in context — keep low (4) so the report
#                               is driven by fresh evidence, not dominated by prior knowledge
# REPORT_NEW_RESPONSES_MAX:    max new response texts sent to LLM. Set to 0 to send ALL new
#                               responses (bounded only by the ABSA cap). Default 0 = no cap.
# REPORT_RESPONSE_TEXT_MAX_LEN: max chars per response verbatim in context
# REPORT_FULL_MAX_TOPICS:      max topics from topic_signals included as structure
REPORT_PRIOR_MIN_TRUST:        int = int(os.getenv("REPORT_PRIOR_MIN_TRUST",       "65"))
REPORT_PRIOR_MAX_INSIGHTS:     int = int(os.getenv("REPORT_PRIOR_MAX_INSIGHTS",     "4"))
REPORT_NEW_RESPONSES_MAX:      int = int(os.getenv("REPORT_NEW_RESPONSES_MAX",      "0"))   # 0 = all new responses
REPORT_RESPONSE_TEXT_MAX_LEN:  int = int(os.getenv("REPORT_RESPONSE_TEXT_MAX_LEN", "350"))
REPORT_FULL_MAX_TOPICS:        int = int(os.getenv("REPORT_FULL_MAX_TOPICS",         "8"))

# ── Report quality ────────────────────────────────────────────────────────────
REPORT_QUALITY_RENARRATE_THRESHOLD = 60    # eval score below this triggers re-narration
CRYSTAL_EVAL_PASS_THRESHOLD = 72           # minimum quality score for Crystal response to pass

# ── Crystal ReAct ─────────────────────────────────────────────────────────────
CRYSTAL_MAX_TOOL_TURNS = 10                # max tool call iterations per Crystal turn
CRYSTAL_CONTEXT_COMPRESSION_THRESHOLD = 40_000  # token count triggering context compression
CRYSTAL_CONVERSATION_WINDOW = 6            # number of prior turns included in context

# ── Progressive data tiers ────────────────────────────────────────────────────
PROGRESSIVE_TIER_FIRST_VOICES = 10         # response count threshold: first_voices tier
PROGRESSIVE_TIER_EARLY_SIGNALS = 40        # response count threshold: early_signals tier
PROGRESSIVE_TIER_GROWING_PICTURE = 70      # response count threshold: growing_picture tier
PROGRESSIVE_TIER_FULL_REPORT = 100         # response count threshold: full_report tier

# ── Object store / checkpoint blobs ──────────────────────────────────────────
CHECKPOINT_BUCKET = ""                     # OCI bucket name (empty → local filesystem)
CHECKPOINT_LOCAL_PATH = "/tmp/checkpoints" # local dev checkpoint directory
CHECKPOINT_BLOB_SCHEMA_VERSION = 1         # current blob schema version

# ── Trigger type validation ───────────────────────────────────────────────────
# Validates trigger values before INSERT into agent_runs / survey_insight_checkpoints.
# Any value outside this set causes a DB CHECK violation — validate first.
VALID_TRIGGER_TYPES: frozenset[str] = frozenset({
    "stream", "scheduler", "manual", "milestone", "api", "days", "responses"
})

# ── Zombie run detection ──────────────────────────────────────────────────────
MAX_RUN_HEARTBEAT_STALE_MINUTES = 5        # heartbeat older than this → zombie candidate
MAX_RUN_DURATION_MINUTES = 30              # run older than this → zombie regardless of heartbeat

# ── Crystal thread lifecycle ──────────────────────────────────────────────────
CRYSTAL_THREAD_INACTIVITY_TTL_DAYS = 7     # inactive thread TTL before reset
CRYSTAL_THREAD_CONTEXT_WINDOW_TURNS = 6    # turns included in Crystal context
CRYSTAL_THREAD_STORAGE_TTL_DAYS = 90       # thread storage retention period

# ── Tiered report agent ───────────────────────────────────────────────────────
REPORT_MAX_RESPONSES_WINDOW = 200          # max responses sent to LLM for any tiered report
REPORT_REGEN_MIN_NEW_RESPONSES = 25        # min new responses since last report to trigger re-run

# ── Narration quality loop ────────────────────────────────────────────────────
NARRATE_MAX_ATTEMPTS = 2                   # max re-narration retries after low evaluate score

# ── Response velocity ─────────────────────────────────────────────────────────
RESPONSE_VELOCITY_UNIT = "per_day"         # velocity = response_count / days_since_first_response

# ── Skill Runtime ─────────────────────────────────────────────────────────────
SKILL_REGISTRY_RELOAD_INTERVAL_DEV:  int   = int(os.getenv("SKILL_REGISTRY_RELOAD_INTERVAL_DEV",   "30"))
SKILL_REGISTRY_RELOAD_INTERVAL_PROD: int   = int(os.getenv("SKILL_REGISTRY_RELOAD_INTERVAL_PROD",  "300"))
SKILL_EVAL_PASS_THRESHOLD:           float = float(os.getenv("SKILL_EVAL_PASS_THRESHOLD",           "0.75"))
SKILL_EXAMPLE_WRITE_THRESHOLD:       float = float(os.getenv("SKILL_EXAMPLE_WRITE_THRESHOLD",       "0.75"))
SKILL_EXAMPLE_MAX_PER_SKILL:         int   = int(os.getenv("SKILL_EXAMPLE_MAX_PER_SKILL",           "50"))
SKILL_DEFAULT_TIMEOUT_SECONDS:       int   = int(os.getenv("SKILL_DEFAULT_TIMEOUT_SECONDS",         "60"))
SKILL_DEFAULT_MAX_RETRIES:           int   = int(os.getenv("SKILL_DEFAULT_MAX_RETRIES",              "1"))
USE_SKILL_RUNTIME:                   bool  = os.getenv("USE_SKILL_RUNTIME", "true").lower() == "true"

# Action-advisor sub-specialists — orchestrated by action-recommender, not Crystal chat routing.
CRYSTAL_ROUTING_EXCLUDED_SKILLS: frozenset[str] = frozenset({
    "nps-action-advisor",
    "ces-action-advisor",
    "csat-action-advisor",
    "enps-action-advisor",
    "close-the-loop-advisor",
    "predictive-action-advisor",
    "segment-action-advisor",
    "journey-advisor",
    "survey-improvement-advisor",
    "distribution-strategist",
    "benchmark-strategist",
    "voc-program-advisor",
})

# ── Memory Layer ──────────────────────────────────────────────────────────────
SEMANTIC_CACHE_TTL_HOURS:       int   = int(os.getenv("SEMANTIC_CACHE_TTL_HOURS",       "24"))
SEMANTIC_CACHE_KEY_PREFIX:      str   = os.getenv("SEMANTIC_CACHE_KEY_PREFIX",          "semantic_cache")
SURVEY_FACTS_KEY_PREFIX:        str   = os.getenv("SURVEY_FACTS_KEY_PREFIX",            "survey_facts")
SURVEY_FACTS_BACKUP_TTL_HOURS:  int   = int(os.getenv("SURVEY_FACTS_BACKUP_TTL_HOURS",  "24"))
ORG_MEMORY_TOP_K:               int   = int(os.getenv("ORG_MEMORY_TOP_K",               "3"))
THREAD_COMPRESS_FIRST_TURN:     int   = int(os.getenv("THREAD_COMPRESS_FIRST_TURN",     "5"))
THREAD_COMPRESS_INTERVAL:       int   = int(os.getenv("THREAD_COMPRESS_INTERVAL",       "3"))
THREAD_ARCHIVE_TURN_THRESHOLD:  int   = int(os.getenv("THREAD_ARCHIVE_TURN_THRESHOLD",  "20"))
ORG_MEMORY_SWEEP_INTERVAL_MIN:  int   = int(os.getenv("ORG_MEMORY_SWEEP_INTERVAL_MIN",  "5"))
HALLUCINATION_FAIL_THRESHOLD:   float = float(os.getenv("HALLUCINATION_FAIL_THRESHOLD", "0.6"))
HALLUCINATION_FLAG_THRESHOLD:   float = float(os.getenv("HALLUCINATION_FLAG_THRESHOLD", "0.8"))
