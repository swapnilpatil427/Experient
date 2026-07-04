"""Insight Pipeline v2 — settings loader + credit pre-flight.

Three responsibilities:

1. ``load_insight_settings(survey_id, org_id)`` — resolves the 3-level COALESCE
   merge ``survey_insight_settings`` → ``org_insight_defaults`` → platform constant
   defaults (``lib/constants.py``). Tolerates missing tables/rows: on ANY failure it
   returns the platform defaults so the pipeline never crashes on config load.

2. ``resolve_stream_response_threshold(survey_id, org_id)`` — the same 3-level
   precedence as above, scoped to just ``stream_response_threshold`` (added
   2026-07-04), for callers that need ONLY this one setting without loading the
   full settings dict — specifically ``consumers/response_stream.py``'s
   standalone streaming consumer, which decides whether to even attempt an
   automated run at all (as opposed to ``node_resolve_context``'s use of the
   full ``load_insight_settings()``, which decides whether to skip a run that's
   already been attempted). Configurable per survey at Experience → Intelligence
   → Settings (``InsightSettingsPage.tsx``'s "Stream response threshold" field),
   or per org via ``org_insight_defaults``. When neither is configured, logs the
   platform-default fallback to the console in dev/dev-paid (previously this
   silently used a hardcoded value with no visibility into why).

3. ``credit_preflight(org_id, run_type, settings)`` — resolves the per-run credit
   cost and checks the org balance. **CrystalOS does NOT debit** — the Node backend
   owns the credit ledger and debits on its ``/runs`` path (see module note below).
   CrystalOS reads the balance only for the automated silent-skip decision. For
   manual/refresh/custom runs it raises ``InsufficientCreditsError`` so the caller
   can surface a 402 *before* a run is started (defence-in-depth — the backend has
   already debited, but if CrystalOS is invoked directly we still refuse).

Credit-debit ownership decision (02 §6):
  The credit ledger lives in the Node backend (Postgres credit_accounts /
  credit_ledger, mirrored by backend/src/lib/creditLedger.ts). To avoid a
  double-debit race between two services writing the same ledger, **the backend
  owns debiting**. CrystalOS reads balance for the skip decision only. This is the
  "safe option" called out in the task spec.
"""
from __future__ import annotations

import os
from typing import Any

from crystalos.lib import db
from crystalos.lib.logger import logger
from crystalos.lib import constants as C


# ── Default settings (platform constant floor) ────────────────────────────────

def _platform_defaults() -> dict[str, Any]:
    """Return the platform-constant settings dict (lowest precedence in the merge)."""
    return {
        # Automated incremental
        "automated_insights_enabled":           True,
        "automated_report_generation_enabled":  True,
        "stream_response_threshold":            C.DEFAULT_STREAM_THRESHOLD,
        "report_regen_threshold":               C.DEFAULT_REPORT_REGEN_THRESHOLD,
        "prior_checkpoint_lookback":            C.DEFAULT_PRIOR_CHECKPOINT_LOOKBACK,
        "prior_checkpoint_max_age_days":        C.DEFAULT_PRIOR_CHECKPOINT_MAX_AGE_DAYS,
        "full_checkpoint_response_threshold":   C.DEFAULT_FULL_CHECKPOINT_THRESHOLD,
        "meaningful_delta_nps_points":          C.DEFAULT_MEANINGFUL_DELTA_NPS_POINTS,
        "meaningful_delta_topic_pct":           C.DEFAULT_MEANINGFUL_DELTA_TOPIC_PCT,
        # Refresh
        "refresh_lookback_days":                C.DEFAULT_REFRESH_LOOKBACK_DAYS,
        "refresh_min_response_count":           C.DEFAULT_REFRESH_MIN_RESPONSE_COUNT,
        "refresh_daily_limit":                  C.DEFAULT_REFRESH_DAILY_LIMIT,
        # Manual expert
        "manual_expert_checkpoint_lookback":    C.DEFAULT_MANUAL_EXPERT_CHECKPOINT_LOOKBACK,
        "manual_expert_max_corpus":             C.DEFAULT_MANUAL_EXPERT_MAX_CORPUS,
        "manual_expert_full_corpus_cap":        C.DEFAULT_MANUAL_EXPERT_FULL_CORPUS_CAP,
        "manual_expert_snapshot_count":         C.DEFAULT_MANUAL_EXPERT_SNAPSHOTS,
        # Manual quick
        "manual_quick_sample_cap":              C.DEFAULT_MANUAL_QUICK_SAMPLE,
        "manual_quick_snapshot_count":          C.DEFAULT_MANUAL_QUICK_SNAPSHOTS,
        "manual_quick_default_window_days":     C.DEFAULT_MANUAL_QUICK_WINDOW_DAYS,
        "manual_daily_run_limit":               C.DEFAULT_MANUAL_DAILY_RUN_LIMIT,
        # Custom analysis
        "custom_analysis_enabled":              True,
        "custom_analysis_daily_limit":          3,
        "custom_analysis_max_corpus":           5000,
        "custom_analysis_min_n_for_nps":        30,
        # Credit costs (None in DB ⇒ fall back to these constants)
        "credit_cost_automated_checkpoint":     C.CREDIT_COST_AUTOMATED_CHECKPOINT,
        "credit_cost_automated_report":         C.CREDIT_COST_AUTOMATED_REPORT,
        "credit_cost_refresh":                  C.CREDIT_COST_REFRESH,
        "credit_cost_manual_quick":             C.CREDIT_COST_MANUAL_QUICK,
        "credit_cost_manual_expert":            C.CREDIT_COST_MANUAL_EXPERT,
        # Retention
        "automated_checkpoint_retention_days":  365,
        "manual_report_retention_days":         730,
        "collapse_similar_checkpoints":         True,
        "config_version":                       1,
    }


# Keys carried on org_insight_defaults (subset of survey settings — 03 §13).
_ORG_DEFAULT_KEYS: frozenset[str] = frozenset({
    "automated_insights_enabled", "automated_report_generation_enabled",
    "stream_response_threshold", "prior_checkpoint_lookback",
    "refresh_lookback_days", "refresh_min_response_count", "refresh_daily_limit",
    "manual_daily_run_limit", "manual_expert_checkpoint_lookback",
    "manual_expert_full_corpus_cap", "manual_expert_max_corpus",
    "custom_analysis_enabled", "custom_analysis_daily_limit",
    "credit_cost_automated_checkpoint", "credit_cost_automated_report",
    "credit_cost_refresh", "credit_cost_manual_quick", "credit_cost_manual_expert",
})


async def _fetch_row(table: str, key_col: str, key_val: str) -> dict[str, Any] | None:
    """Fetch a single settings row as a dict, or None if table/row absent. Never raises."""
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    f"SELECT * FROM {table} WHERE {key_col} = %s LIMIT 1",  # noqa: S608 - table is a constant literal
                    (key_val,),
                )
                row = await cur.fetchone()
                if row is None:
                    return None
                cols = [d[0] for d in cur.description]
                return dict(zip(cols, row))
    except Exception as exc:
        logger.warning("insight_settings_fetch_failed", table=table, key=key_val, error=str(exc))
        return None


async def load_insight_settings(survey_id: str, org_id: str) -> dict[str, Any]:
    """Resolve effective insight settings via the 3-level COALESCE merge.

    Precedence (highest → lowest):
      survey_insight_settings[survey_id] → org_insight_defaults[org_id] → constants.

    A value in a higher level only wins when it is non-NULL. The result is a plain
    dict keyed by setting name. Always returns a complete dict (every key present)
    even when both tables are missing — falls through to platform defaults.
    """
    merged = _platform_defaults()

    # Level 2: org defaults (only the subset of keys it carries).
    org_row = await _fetch_row("org_insight_defaults", "org_id", org_id)
    if org_row:
        for k in _ORG_DEFAULT_KEYS:
            v = org_row.get(k)
            if v is not None:
                merged[k] = v

    # Level 1: per-survey settings (full key set). Non-NULL wins.
    survey_row = await _fetch_row("survey_insight_settings", "survey_id", survey_id)
    if survey_row:
        for k, v in survey_row.items():
            if k in ("survey_id", "org_id", "updated_at", "updated_by"):
                continue
            if v is not None and k in merged:
                merged[k] = v
            elif v is not None:
                # Carry through any column we did not anticipate (forward-compat).
                merged[k] = v

    return merged


# ── Stream response threshold (standalone resolver) ────────────────────────────

def _log_stream_threshold_fallback(survey_id: str, org_id: str) -> None:
    """Console-print (dev/dev-paid only) when stream_response_threshold falls
    through to the platform default — i.e. neither this survey nor its org has
    ever configured it. Fixed 2026-07-04: previously a silent hardcoded value
    with zero visibility into why an automated run wasn't triggering as
    expected during local testing. Uses plain print() (not the structured
    logger) specifically because the ask is console readability with real
    newlines, not a one-line structured log entry — production environments
    don't get this (see AGENTS_ENV check below), where the structured
    `stream_response_threshold_defaulted` log line is the source of truth."""
    agents_env = os.getenv("AGENTS_ENV", "dev")
    if agents_env not in ("dev", "dev-paid"):
        return
    print(
        "\n"
        "──────────────────────────────────────────────────────────────\n"
        "  stream_response_threshold is not configured for this survey\n"
        "  or its org — falling back to the platform default.\n"
        f"    survey_id = {survey_id}\n"
        f"    org_id    = {org_id}\n"
        f"    default   = {C.DEFAULT_STREAM_THRESHOLD} new responses\n"
        "  Configure it at Experience → Intelligence → Settings (per survey)\n"
        "  or via org_insight_defaults (per org) to change this.\n"
        "──────────────────────────────────────────────────────────────\n"
    )


async def resolve_stream_response_threshold(survey_id: str, org_id: str) -> int:
    """Resolve stream_response_threshold with the same survey → org → platform
    precedence as load_insight_settings(), but scoped to just this one setting
    and without loading the rest of the settings dict — for callers (currently
    only the standalone response_stream.py consumer) that need just this value
    on every incoming event and shouldn't pay for the full settings load each
    time.

    An explicit INSIGHT_NEW_RESPONSE_THRESHOLD env var, if set, is an ops
    escape hatch that wins outright (no console log — it's an intentional
    override, not an absent one).

    Note on "configured" for the survey level: survey_insight_settings.
    stream_response_threshold is a NOT NULL DEFAULT 10 column (any row that
    exists always has *some* value), so "configured" here means "a
    survey_insight_settings row exists at all" — it cannot distinguish a
    customer who explicitly set this exact field from one who saved some
    other field on the same settings form and never touched this one. The
    org-level column is nullable and does support a true "not set" signal.
    """
    env_override = os.getenv("INSIGHT_NEW_RESPONSE_THRESHOLD")
    if env_override:
        try:
            return int(env_override)
        except ValueError:
            logger.warning("insight_new_response_threshold_env_invalid", value=env_override)

    survey_row = await _fetch_row("survey_insight_settings", "survey_id", survey_id)
    if survey_row and survey_row.get("stream_response_threshold") is not None:
        return int(survey_row["stream_response_threshold"])

    org_row = await _fetch_row("org_insight_defaults", "org_id", org_id)
    if org_row and org_row.get("stream_response_threshold") is not None:
        return int(org_row["stream_response_threshold"])

    logger.info("stream_response_threshold_defaulted", survey_id=survey_id, org_id=org_id,
                default=C.DEFAULT_STREAM_THRESHOLD)
    _log_stream_threshold_fallback(survey_id, org_id)
    return C.DEFAULT_STREAM_THRESHOLD


# ── Credit pre-flight ─────────────────────────────────────────────────────────

class InsufficientCreditsError(Exception):
    """Raised by credit_preflight for manual/refresh/custom runs when balance < cost."""

    def __init__(self, required: int, available: int):
        self.required = required
        self.available = available
        super().__init__(f"insufficient_credits: required={required} available={available}")


# Map run_type → settings key + constant fallback for cost resolution.
_COST_KEYS: dict[str, tuple[str, int]] = {
    "automated_incremental": ("credit_cost_automated_checkpoint", C.CREDIT_COST_AUTOMATED_CHECKPOINT),
    "refresh":               ("credit_cost_refresh",              C.CREDIT_COST_REFRESH),
    "manual_quick":          ("credit_cost_manual_quick",         C.CREDIT_COST_MANUAL_QUICK),
    "manual_expert":         ("credit_cost_manual_expert",        C.CREDIT_COST_MANUAL_EXPERT),
    "custom":                ("credit_cost_custom_base",          C.CREDIT_COST_CUSTOM_BASE),
}


def resolve_credit_cost(run_type: str, settings: dict, *, include_report: bool = False) -> int:
    """Resolve the credit cost for a run from settings, falling back to constants.

    For automated runs ``include_report=True`` adds the report-generation surcharge
    (04 §16 routing) on top of the checkpoint cost.
    """
    settings = settings or {}
    key, fallback = _COST_KEYS.get(run_type, _COST_KEYS["automated_incremental"])
    base = settings.get(key)
    try:
        cost = int(base) if base is not None else int(fallback)
    except (TypeError, ValueError):
        cost = int(fallback)
    if run_type == "automated_incremental" and include_report:
        rep = settings.get("credit_cost_automated_report")
        try:
            cost += int(rep) if rep is not None else int(C.CREDIT_COST_AUTOMATED_REPORT)
        except (TypeError, ValueError):
            cost += int(C.CREDIT_COST_AUTOMATED_REPORT)
    return cost


async def get_org_credit_balance(org_id: str) -> int | None:
    """Read the org credit balance from the backend ledger tables.

    Mirrors backend/src/lib/creditLedger.ts: balance = allowance_remaining +
    pack_remaining (overage is unbounded, ignored for the skip check). Returns None
    when the credit tables don't exist (treated as "unlimited / unknown" by callers,
    which then never silently skip). Never raises.
    """
    try:
        async with db._pool_conn().connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """SELECT COALESCE(allowance_remaining, 0) + COALESCE(pack_remaining, 0)
                       FROM credit_accounts WHERE org_id = %s LIMIT 1""",
                    (org_id,),
                )
                row = await cur.fetchone()
                if row is None:
                    return None
                return int(row[0] or 0)
    except Exception as exc:
        logger.warning("get_org_credit_balance_failed", org_id=org_id, error=str(exc))
        return None


async def credit_preflight(
    org_id: str,
    run_type: str,
    settings: dict,
    *,
    include_report: bool = False,
) -> bool:
    """Pre-flight credit check (02 §6). CrystalOS reads balance; it does NOT debit.

    Returns:
      True  — sufficient credits (or balance unknown ⇒ do not block).
      False — automated run with insufficient credits → silent skip (logged).

    Raises:
      InsufficientCreditsError — manual / refresh / custom run with insufficient
      credits → caller surfaces HTTP 402.
    """
    cost = resolve_credit_cost(run_type, settings, include_report=include_report)
    balance = await get_org_credit_balance(org_id)

    # Balance unknown (ledger tables absent / dev) → never block; backend is the
    # authoritative gate. This keeps dev + tests running without a ledger.
    if balance is None:
        return True

    if balance < cost:
        if run_type == "automated_incremental":
            logger.info("credit_preflight_insufficient_skip", org_id=org_id,
                        run_type=run_type, required=cost, available=balance)
            return False  # silent skip — caller aborts the run, no error
        raise InsufficientCreditsError(required=cost, available=balance)

    # Sufficient. Debiting is owned by the backend (see module docstring) — no debit here.
    return True
