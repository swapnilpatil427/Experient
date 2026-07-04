"""Unit tests for Insight Pipeline v2 — Phase 2 + Phase 3.

Covers:
  - tools/delta.compute_topic_lifecycle  (share-weighted emerged/growing/.../resolved)
  - tools/sampling.stratified_sample / recency_weighted_sample
  - lib/insight_settings.load_insight_settings  (3-level COALESCE merge + fallback)
  - lib/insight_settings.resolve_credit_cost / credit_preflight
  - graphs/insights.node_resolve_context  (bootstrap / automated / refresh / manual windows)
  - graphs/insights.walk_parent_chain     (v2 → legacy fallback)
  - graphs/insights.node_publish_manual    (insight_reports + v2 manual checkpoint, no supersede)

Mock rules (CLAUDE.md): AsyncMock for async fns; patch db._pool_conn; never call real LLMs/DB.
"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from datetime import datetime, timezone, timedelta

from crystalos.tools.delta import compute_topic_lifecycle
from crystalos.tools.sampling import stratified_sample, recency_weighted_sample
from crystalos.graphs.insights import (
    node_resolve_context, walk_parent_chain, node_publish_manual, _derive_profile,
)
from crystalos.lib.constants import (
    INSIGHT_PROFILE_AUTOMATED, INSIGHT_PROFILE_REFRESH,
    INSIGHT_PROFILE_MANUAL_EXPERT, INSIGHT_PROFILE_MANUAL_QUICK,
)


# ── DB mock helpers ───────────────────────────────────────────────────────────

class _Cursor:
    """Async cursor mock driven by a queue of (description, rows) result sets.

    Each execute() pops the next result; fetchone/fetchall read from it. Calls past
    the end of the queue return an empty result set.
    """
    def __init__(self, results):
        self._results = list(results)
        self._idx = 0
        self.description = None
        self._rows = []
        self.execute_calls = []

    async def execute(self, sql, params=None):
        self.execute_calls.append((sql, params or ()))
        if self._idx < len(self._results):
            desc, rows = self._results[self._idx]
            self._idx += 1
        else:
            desc, rows = (None, [])
        self.description = desc
        self._rows = list(rows)

    async def fetchone(self):
        return self._rows[0] if self._rows else None

    async def fetchall(self):
        return list(self._rows)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _Conn:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor

    async def execute(self, sql, params=None):
        self._cursor.execute_calls.append((sql, params or ()))

    async def commit(self):
        return None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def _pool_for(cursor):
    conn = _Conn(cursor)
    pool = MagicMock()
    pool.connection = MagicMock(return_value=conn)
    return pool


def _desc(*names):
    return [(n,) for n in names]


# ── compute_topic_lifecycle ───────────────────────────────────────────────────

class TestComputeTopicLifecycle:
    def test_emerged_growing_stable_declining_resolved(self):
        parent = [
            {"name": "Billing", "volume_share": 0.20},
            {"name": "Login",   "volume_share": 0.15},
            {"name": "Pricing", "volume_share": 0.10},
            {"name": "Support", "volume_share": 0.30},
        ]
        current = [
            {"name": "Billing", "volume_share": 0.21},   # stable (+1pp)
            {"name": "Pricing", "volume_share": 0.04},   # declining (-6pp)
            {"name": "Support", "volume_share": 0.40},   # growing (+10pp)
            {"name": "AI features", "volume_share": 0.08},  # emerged (>=3%)
            # Login absent → resolved (was 15% >= 3%)
        ]
        out = compute_topic_lifecycle(parent, current)
        names = lambda key: {x["name"] for x in out[key]}
        assert "AI features" in names("emerged")
        assert "Support" in names("growing")
        assert "Pricing" in names("declining")
        assert "Login" in names("resolved")
        assert "Billing" in out["stable"]
        assert out["fingerprint_changed"] is True

    def test_emerged_below_floor_not_emerged(self):
        parent = [{"name": "A", "volume_share": 0.5}]
        current = [{"name": "A", "volume_share": 0.5}, {"name": "B", "volume_share": 0.01}]
        out = compute_topic_lifecycle(parent, current)
        assert out["emerged"] == []        # B below 3% floor
        assert "B" in out["stable"]

    def test_accepts_topic_signals_dict_shape(self):
        # state["topic_signals"] style: {name: {response_pct,...}}
        parent = {"X": {"volume_share": 0.10}}
        current = {"X": {"response_pct": 20.0}}  # 0.20 share → +10pp growing
        out = compute_topic_lifecycle(parent, current)
        assert {x["name"] for x in out["growing"]} == {"X"}

    def test_identical_sets_no_fingerprint_change(self):
        topics = [{"name": "A", "volume_share": 0.5}, {"name": "B", "volume_share": 0.5}]
        out = compute_topic_lifecycle(topics, topics)
        assert out["fingerprint_changed"] is False
        assert set(out["stable"]) == {"A", "B"}


# ── Sampling helpers ──────────────────────────────────────────────────────────

def _rows(n, days_span=60):
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    out = []
    for i in range(n):
        out.append({
            "id": f"r{i}",
            "submitted_at": base + timedelta(days=(i % days_span)),
            "nps_score": (i % 11),
            "sentiment": ["negative", "neutral", "positive"][i % 3],
        })
    return out


class TestSampling:
    def test_stratified_returns_all_when_under_cap(self):
        rows = _rows(10)
        out = stratified_sample(rows, cap=50)
        assert set(out) == {f"r{i}" for i in range(10)}

    def test_stratified_caps_and_dedups(self):
        rows = _rows(500)
        out = stratified_sample(rows, cap=100)
        assert len(out) == 100
        assert len(set(out)) == 100

    def test_stratified_deterministic_with_seed(self):
        rows = _rows(300)
        a = stratified_sample(rows, cap=80, seed=7)
        b = stratified_sample(rows, cap=80, seed=7)
        assert a == b

    def test_recency_returns_all_when_under_cap(self):
        rows = _rows(20)
        out = recency_weighted_sample(rows, cap=150)
        assert set(out) == {f"r{i}" for i in range(20)}

    def test_recency_caps(self):
        rows = _rows(1000)
        out = recency_weighted_sample(rows, cap=150)
        assert len(out) == 150
        assert len(set(out)) == 150

    def test_recency_prefers_recent(self):
        # Newest rows have the largest day offset; recency sample should over-index them.
        rows = _rows(400, days_span=400)
        out = set(recency_weighted_sample(rows, cap=150, seed=1))
        # The 60 most-recent ids (r340..r399 by offset) should be heavily represented.
        recent_ids = {f"r{i}" for i in range(340, 400)}
        assert len(out & recent_ids) >= 30


# ── Settings loader ───────────────────────────────────────────────────────────

class TestLoadInsightSettings:
    @pytest.mark.asyncio
    async def test_returns_defaults_when_tables_missing(self):
        # Every _fetch_row raises → falls back to platform defaults.
        with patch("crystalos.lib.insight_settings._fetch_row", new=AsyncMock(return_value=None)):
            from crystalos.lib.insight_settings import load_insight_settings
            s = await load_insight_settings("s1", "org-1")
        assert s["stream_response_threshold"] == 100
        assert s["meaningful_delta_nps_points"] == 2.0
        assert s["credit_cost_manual_expert"] == 40
        assert s["prior_checkpoint_lookback"] == 5

    @pytest.mark.asyncio
    async def test_survey_overrides_org_overrides_constant(self):
        async def fake_fetch(table, key_col, key_val):
            if table == "org_insight_defaults":
                return {"org_id": "org-1", "stream_response_threshold": 20,
                        "prior_checkpoint_lookback": 7, "refresh_daily_limit": None}
            if table == "survey_insight_settings":
                return {"survey_id": "s1", "org_id": "org-1",
                        "stream_response_threshold": 50,  # survey wins over org's 20
                        "prior_checkpoint_lookback": None}  # NULL → org's 7 wins
            return None
        with patch("crystalos.lib.insight_settings._fetch_row", new=AsyncMock(side_effect=fake_fetch)):
            from crystalos.lib.insight_settings import load_insight_settings
            s = await load_insight_settings("s1", "org-1")
        assert s["stream_response_threshold"] == 50    # survey override
        assert s["prior_checkpoint_lookback"] == 7      # org override (survey NULL)
        assert s["refresh_daily_limit"] == 5            # constant (both NULL)


class TestResolveStreamResponseThreshold:
    """resolve_stream_response_threshold — added 2026-07-04 so
    consumers/response_stream.py's automated-trigger consumer honours the same
    UI-configurable stream_response_threshold setting (Experience → Intelligence
    → Settings) that node_resolve_context's skip-run gate already did, instead of
    a flat env-var-only value shared by every survey. Precedence: explicit
    INSIGHT_NEW_RESPONSE_THRESHOLD env override > survey row > org row (non-null)
    > platform constant (with a dev/dev-paid console log on that last fallback)."""

    def setup_method(self):
        import os
        self._env_backup = dict(os.environ)
        os.environ.pop("INSIGHT_NEW_RESPONSE_THRESHOLD", None)

    def teardown_method(self):
        import os
        os.environ.clear()
        os.environ.update(self._env_backup)

    @pytest.mark.asyncio
    async def test_survey_row_wins(self):
        async def fake_fetch(table, key_col, key_val):
            if table == "survey_insight_settings":
                return {"survey_id": "s1", "stream_response_threshold": 42}
            return {"org_id": "org-1", "stream_response_threshold": 20}  # would lose anyway
        with patch("crystalos.lib.insight_settings._fetch_row", new=AsyncMock(side_effect=fake_fetch)):
            from crystalos.lib.insight_settings import resolve_stream_response_threshold
            assert await resolve_stream_response_threshold("s1", "org-1") == 42

    @pytest.mark.asyncio
    async def test_org_row_wins_when_no_survey_row(self):
        async def fake_fetch(table, key_col, key_val):
            if table == "survey_insight_settings":
                return None
            return {"org_id": "org-1", "stream_response_threshold": 20}
        with patch("crystalos.lib.insight_settings._fetch_row", new=AsyncMock(side_effect=fake_fetch)):
            from crystalos.lib.insight_settings import resolve_stream_response_threshold
            assert await resolve_stream_response_threshold("s1", "org-1") == 20

    @pytest.mark.asyncio
    async def test_org_row_with_null_threshold_falls_through_to_platform_default(self):
        # org_insight_defaults.stream_response_threshold IS nullable (NULL means
        # "use platform constant") — unlike survey_insight_settings' NOT NULL
        # DEFAULT 10 column, this genuinely signals "not configured."
        async def fake_fetch(table, key_col, key_val):
            if table == "survey_insight_settings":
                return None
            return {"org_id": "org-1", "stream_response_threshold": None}
        with patch("crystalos.lib.insight_settings._fetch_row", new=AsyncMock(side_effect=fake_fetch)):
            from crystalos.lib.insight_settings import resolve_stream_response_threshold
            assert await resolve_stream_response_threshold("s1", "org-1") == 100

    @pytest.mark.asyncio
    async def test_falls_back_to_platform_default_when_neither_row_exists(self):
        with patch("crystalos.lib.insight_settings._fetch_row", new=AsyncMock(return_value=None)):
            from crystalos.lib.insight_settings import resolve_stream_response_threshold
            assert await resolve_stream_response_threshold("s1", "org-1") == 100

    @pytest.mark.asyncio
    async def test_env_override_wins_outright_even_with_configured_rows(self):
        import os
        os.environ["INSIGHT_NEW_RESPONSE_THRESHOLD"] = "3"
        fetch_mock = AsyncMock(return_value={"stream_response_threshold": 42})
        with patch("crystalos.lib.insight_settings._fetch_row", new=fetch_mock):
            from crystalos.lib.insight_settings import resolve_stream_response_threshold
            assert await resolve_stream_response_threshold("s1", "org-1") == 3
        fetch_mock.assert_not_awaited()  # env override short-circuits the DB lookups entirely

    @pytest.mark.asyncio
    async def test_logs_fallback_to_console_in_dev(self, capsys):
        import os
        os.environ["AGENTS_ENV"] = "dev"
        with patch("crystalos.lib.insight_settings._fetch_row", new=AsyncMock(return_value=None)):
            from crystalos.lib.insight_settings import resolve_stream_response_threshold
            await resolve_stream_response_threshold("s1", "org-1")
        out = capsys.readouterr().out
        assert "stream_response_threshold" in out
        assert "s1" in out
        assert "org-1" in out
        assert "100" in out
        assert "\n" in out.strip()  # multi-line, per the "log with new lines" ask

    @pytest.mark.asyncio
    async def test_does_not_log_to_console_in_production(self, capsys):
        # The structured logger.info(...) call still fires in production (that's
        # the source of truth there) — only the special multi-line human-readable
        # print() block is dev/dev-paid-only, so assert its distinctive framing
        # is absent rather than asserting stdout is silent altogether.
        import os
        os.environ["AGENTS_ENV"] = "production"
        with patch("crystalos.lib.insight_settings._fetch_row", new=AsyncMock(return_value=None)):
            from crystalos.lib.insight_settings import resolve_stream_response_threshold
            await resolve_stream_response_threshold("s1", "org-1")
        out = capsys.readouterr().out
        assert "Configure it at Experience" not in out
        assert "──" not in out

    @pytest.mark.asyncio
    async def test_does_not_log_to_console_when_survey_row_configures_it(self, capsys):
        import os
        os.environ["AGENTS_ENV"] = "dev"
        with patch("crystalos.lib.insight_settings._fetch_row",
                   new=AsyncMock(return_value={"stream_response_threshold": 42})):
            from crystalos.lib.insight_settings import resolve_stream_response_threshold
            await resolve_stream_response_threshold("s1", "org-1")
        assert capsys.readouterr().out == ""


class TestCreditPreflight:
    def test_resolve_cost_from_settings(self):
        from crystalos.lib.insight_settings import resolve_credit_cost
        s = {"credit_cost_manual_expert": 99}
        assert resolve_credit_cost("manual_expert", s) == 99

    def test_resolve_cost_falls_back_to_constant(self):
        from crystalos.lib.insight_settings import resolve_credit_cost
        assert resolve_credit_cost("refresh", {}) == 8

    def test_resolve_cost_automated_with_report(self):
        from crystalos.lib.insight_settings import resolve_credit_cost
        assert resolve_credit_cost("automated_incremental", {}, include_report=True) == 5 + 15

    @pytest.mark.asyncio
    async def test_automated_silent_skip_on_insufficient(self):
        from crystalos.lib.insight_settings import credit_preflight
        with patch("crystalos.lib.insight_settings.get_org_credit_balance", new=AsyncMock(return_value=0)):
            ok = await credit_preflight("org-1", "automated_incremental", {})
        assert ok is False

    @pytest.mark.asyncio
    async def test_manual_raises_on_insufficient(self):
        from crystalos.lib.insight_settings import credit_preflight, InsufficientCreditsError
        with patch("crystalos.lib.insight_settings.get_org_credit_balance", new=AsyncMock(return_value=1)):
            with pytest.raises(InsufficientCreditsError):
                await credit_preflight("org-1", "manual_expert", {})

    @pytest.mark.asyncio
    async def test_unknown_balance_never_blocks(self):
        from crystalos.lib.insight_settings import credit_preflight
        with patch("crystalos.lib.insight_settings.get_org_credit_balance", new=AsyncMock(return_value=None)):
            assert await credit_preflight("org-1", "manual_expert", {}) is True


# ── _derive_profile ───────────────────────────────────────────────────────────

class TestDeriveProfile:
    def test_explicit_profile_wins(self):
        assert _derive_profile("stream", "manual_expert") == "manual_expert"

    def test_refresh_trigger(self):
        assert _derive_profile("refresh", None) == INSIGHT_PROFILE_REFRESH

    def test_legacy_manual_stays_automated(self):
        # Legacy UI Refresh (trigger='manual') must remain automated for back-compat.
        assert _derive_profile("manual", None) == INSIGHT_PROFILE_AUTOMATED

    def test_default_automated(self):
        assert _derive_profile("scheduler", None) == INSIGHT_PROFILE_AUTOMATED


# ── walk_parent_chain ─────────────────────────────────────────────────────────

class TestWalkParentChain:
    @pytest.mark.asyncio
    async def test_reads_v2_first(self):
        v2_rows = [(1, "automated", datetime(2026, 1, 2, tzinfo=timezone.utc))]
        cur = _Cursor([(_desc("checkpoint_number", "lane", "created_at"), v2_rows)])
        with patch("crystalos.graphs.insights.db._pool_conn", return_value=_pool_for(cur)):
            out = await walk_parent_chain("s1", "org-1", 5)
        assert len(out) == 1
        assert out[0]["lane"] == "automated"

    @pytest.mark.asyncio
    async def test_falls_back_to_legacy_when_v2_empty(self):
        # First result (v2) empty; second result (legacy) has a row.
        legacy_rows = [(3, datetime(2026, 1, 1, tzinfo=timezone.utc))]
        cur = _Cursor([
            (_desc("checkpoint_number", "created_at"), []),          # v2 empty
            (_desc("checkpoint_number", "created_at"), legacy_rows), # legacy hit
        ])
        with patch("crystalos.graphs.insights.db._pool_conn", return_value=_pool_for(cur)):
            out = await walk_parent_chain("s1", "org-1", 5)
        assert len(out) == 1
        assert out[0]["checkpoint_number"] == 3

    @pytest.mark.asyncio
    async def test_zero_lookback_returns_empty(self):
        out = await walk_parent_chain("s1", "org-1", 0)
        assert out == []


# ── node_resolve_context ──────────────────────────────────────────────────────

def _base_state(**kw):
    s = {
        "survey_id": "s1", "org_id": "org-1", "run_id": "run-1",
        "trigger": "scheduler", "profile": INSIGHT_PROFILE_AUTOMATED,
        "config_override": {}, "errors": [],
    }
    s.update(kw)
    return s


class TestResolveContextAutomated:
    @pytest.mark.asyncio
    async def test_bootstrap_when_no_parent(self):
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.lib.insight_settings.load_insight_settings",
                  new=AsyncMock(return_value={"automated_insights_enabled": True,
                                              "automated_report_generation_enabled": True,
                                              "stream_response_threshold": 10,
                                              "prior_checkpoint_lookback": 5})),
            patch("crystalos.graphs.insights.walk_parent_chain", new=AsyncMock(return_value=[])),
            patch("crystalos.graphs.insights._load_recent_snapshots", new=AsyncMock(return_value=[])),
        ):
            out = await node_resolve_context(_base_state())
        assert out["is_bootstrap"] is True
        assert out["watermark"] is None
        assert out["skip_run"] is False
        assert out["profile"] == INSIGHT_PROFILE_AUTOMATED

    @pytest.mark.asyncio
    async def test_legacy_only_parent_does_not_leak_a_foreign_parent_checkpoint_id(self):
        """Regression test (2026-07-04): walk_parent_chain() falls back to the
        legacy survey_insight_checkpoints table when insight_checkpoints_v2 has
        no rows yet for this survey. That legacy row's `id` is real in ITS OWN
        table but was never inserted into insight_checkpoints_v2 — using it as
        parent_checkpoint_id there always violated the FK
        (insight_checkpoints_v2_parent_checkpoint_id_fkey), silently failing
        checkpoint_v2_write_failed for every survey whose only prior history
        predates the v2 migration (confirmed against a real production log).
        Both tables stamp schema_version (legacy DEFAULT 1, v2 DEFAULT 2); a
        legacy-sourced parent must never be treated as a valid v2 lineage link.

        is_bootstrap must ALSO be True in this scenario, not just
        parent_checkpoint_id blanked — node_ingest ANDs this value with its own
        (correctly v2-based) bootstrap check, so leaving it False here silently
        overrode that correct answer, making node_ingest treat the run as a
        narrow incremental fetch against an empty new_response_ids (watermark
        is also None for a legacy parent) instead of the wide historical
        sample a true first v2 run needs. Confirmed against a real
        reproduction: the checkpoint got written successfully (previous fix),
        but ABSA/topics/sentiment/emotion/effort were never computed for any
        of the survey's 150 existing responses, because node_ingest believed
        there was nothing new to look at."""
        legacy_parent = {
            "id": "legacy-ckpt-not-in-v2", "schema_version": 1,
            "checkpoint_number": 3,
            # Legacy survey_insight_checkpoints has no response_high_watermark
            # column at all — absent here exactly as a real row would be.
        }
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.lib.insight_settings.load_insight_settings",
                  new=AsyncMock(return_value={"automated_insights_enabled": True,
                                              "automated_report_generation_enabled": True,
                                              "stream_response_threshold": 10,
                                              "prior_checkpoint_lookback": 5})),
            patch("crystalos.graphs.insights.walk_parent_chain", new=AsyncMock(return_value=[legacy_parent])),
            patch("crystalos.graphs.insights._load_recent_snapshots", new=AsyncMock(return_value=[])),
        ):
            out = await node_resolve_context(_base_state())
        # The whole point: never forward the legacy id as a v2 FK target.
        assert out["parent_checkpoint_id"] == ""
        # Falls through to the same safe behavior as a true bootstrap: no
        # watermark (legacy rows don't have one), so the run proceeds and does
        # a wide sample rather than incorrectly skipping as "below threshold."
        assert out["watermark"] is None
        assert out["skip_run"] is False
        # The other half of this fix: must present as a genuine bootstrap so
        # node_ingest loads the wide historical sample, not an empty
        # incremental delta.
        assert out["is_bootstrap"] is True

    @pytest.mark.asyncio
    async def test_v2_parent_correctly_used_as_lineage_link(self):
        """Companion to the regression test above: a genuine v2-sourced parent
        (schema_version=2) IS used as parent_checkpoint_id — confirms the fix
        distinguishes the two cases rather than always blanking it out."""
        v2_parent = {
            "id": "v2-ckpt-real", "schema_version": 2,
            "response_high_watermark": datetime(2026, 1, 1, tzinfo=timezone.utc),
        }
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.lib.insight_settings.load_insight_settings",
                  new=AsyncMock(return_value={"automated_insights_enabled": True,
                                              "automated_report_generation_enabled": True,
                                              "stream_response_threshold": 10,
                                              "prior_checkpoint_lookback": 5})),
            patch("crystalos.graphs.insights.walk_parent_chain", new=AsyncMock(return_value=[v2_parent])),
            patch("crystalos.graphs.insights.db._pool_conn", return_value=_pool_for(_Cursor([(_desc("id", "submitted_at"), [])]))),
        ):
            out = await node_resolve_context(_base_state())
        assert out["parent_checkpoint_id"] == "v2-ckpt-real"
        assert out["watermark"] == datetime(2026, 1, 1, tzinfo=timezone.utc)
        assert out["is_bootstrap"] is False

    @pytest.mark.asyncio
    async def test_automated_disabled_skips(self):
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.lib.insight_settings.load_insight_settings",
                  new=AsyncMock(return_value={"automated_insights_enabled": False})),
        ):
            out = await node_resolve_context(_base_state())
        assert out["skip_run"] is True
        assert out["skip_reason"] == "automated_disabled"

    @pytest.mark.asyncio
    async def test_below_threshold_skips(self):
        parent = {"id": "ck1", "schema_version": 2, "response_high_watermark": datetime(2026, 1, 1, tzinfo=timezone.utc)}
        # new_response_ids query returns 2 rows; threshold is 10 → skip.
        new_rows = [("a", datetime(2026, 1, 2, tzinfo=timezone.utc)),
                    ("b", datetime(2026, 1, 3, tzinfo=timezone.utc))]
        cur = _Cursor([(_desc("id", "submitted_at"), new_rows)])
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.lib.insight_settings.load_insight_settings",
                  new=AsyncMock(return_value={"automated_insights_enabled": True,
                                              "automated_report_generation_enabled": True,
                                              "stream_response_threshold": 10,
                                              "prior_checkpoint_lookback": 5})),
            patch("crystalos.graphs.insights.walk_parent_chain", new=AsyncMock(return_value=[parent])),
            patch("crystalos.graphs.insights.db._pool_conn", return_value=_pool_for(cur)),
        ):
            out = await node_resolve_context(_base_state())
        assert out["skip_run"] is True
        assert out["skip_reason"] == "below_threshold"
        assert len(out["new_response_ids"]) == 2

    @pytest.mark.asyncio
    async def test_milestone_trigger_bypasses_threshold(self):
        parent = {"id": "ck1", "schema_version": 2, "response_high_watermark": datetime(2026, 1, 1, tzinfo=timezone.utc)}
        new_rows = [("a", datetime(2026, 1, 2, tzinfo=timezone.utc))]
        cur = _Cursor([(_desc("id", "submitted_at"), new_rows)])
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.lib.insight_settings.load_insight_settings",
                  new=AsyncMock(return_value={"automated_insights_enabled": True,
                                              "automated_report_generation_enabled": True,
                                              "stream_response_threshold": 10,
                                              "prior_checkpoint_lookback": 5})),
            patch("crystalos.graphs.insights.walk_parent_chain", new=AsyncMock(return_value=[parent])),
            patch("crystalos.graphs.insights._load_recent_snapshots", new=AsyncMock(return_value=[])),
            patch("crystalos.graphs.insights.db._pool_conn", return_value=_pool_for(cur)),
        ):
            out = await node_resolve_context(_base_state(trigger="milestone"))
        assert out["skip_run"] is False


class TestResolveContextManualRefresh:
    @pytest.mark.asyncio
    async def test_refresh_sets_window_and_force(self):
        corpus = [{"id": f"r{i}"} for i in range(40)]
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.lib.insight_settings.load_insight_settings",
                  new=AsyncMock(return_value={"refresh_lookback_days": 30,
                                              "refresh_min_response_count": 25,
                                              "prior_checkpoint_lookback": 5})),
            patch("crystalos.graphs.insights.walk_parent_chain", new=AsyncMock(return_value=[])),
            patch("crystalos.graphs.insights._load_response_meta_in_window",
                  new=AsyncMock(return_value=corpus)),
            patch("crystalos.graphs.insights._load_recent_snapshots", new=AsyncMock(return_value=[])),
        ):
            out = await node_resolve_context(_base_state(profile=INSIGHT_PROFILE_REFRESH))
        assert out["force_regenerate"] is True
        assert out["window_start"] is not None and out["window_end"] is not None
        assert len(out["sample_ids"]) == 40
        assert out["skip_run"] is False

    @pytest.mark.asyncio
    async def test_manual_expert_full_corpus_when_small(self):
        corpus = [{"id": f"r{i}"} for i in range(100)]   # <= full_corpus_cap 500
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.lib.insight_settings.load_insight_settings",
                  new=AsyncMock(return_value={"manual_expert_full_corpus_cap": 500,
                                              "manual_expert_max_corpus": 2000,
                                              "manual_expert_snapshot_count": 5,
                                              "prior_checkpoint_lookback": 3})),
            patch("crystalos.graphs.insights.walk_parent_chain", new=AsyncMock(return_value=[])),
            patch("crystalos.graphs.insights._load_response_meta_in_window",
                  new=AsyncMock(return_value=corpus)),
            patch("crystalos.graphs.insights._load_recent_snapshots", new=AsyncMock(return_value=[])),
        ):
            out = await node_resolve_context(_base_state(profile=INSIGHT_PROFILE_MANUAL_EXPERT))
        assert len(out["sample_ids"]) == 100   # full corpus (no sampling)
        assert out["sample_stats"]["corpus_size"] == 100

    @pytest.mark.asyncio
    async def test_manual_quick_samples_to_cap(self):
        corpus = [{"id": f"r{i}",
                   "submitted_at": datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(hours=i),
                   "sentiment": ["negative", "neutral", "positive"][i % 3]}
                  for i in range(400)]
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.lib.insight_settings.load_insight_settings",
                  new=AsyncMock(return_value={"manual_quick_sample_cap": 150,
                                              "manual_quick_snapshot_count": 2,
                                              "manual_quick_default_window_days": 14,
                                              "prior_checkpoint_lookback": 1})),
            patch("crystalos.graphs.insights.walk_parent_chain", new=AsyncMock(return_value=[])),
            patch("crystalos.graphs.insights._load_response_meta_in_window",
                  new=AsyncMock(return_value=corpus)),
            patch("crystalos.graphs.insights._load_recent_snapshots", new=AsyncMock(return_value=[])),
        ):
            out = await node_resolve_context(_base_state(profile=INSIGHT_PROFILE_MANUAL_QUICK))
        assert len(out["sample_ids"]) == 150

    @pytest.mark.asyncio
    async def test_manual_empty_window_skips(self):
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.lib.insight_settings.load_insight_settings",
                  new=AsyncMock(return_value={"manual_expert_full_corpus_cap": 500,
                                              "manual_expert_max_corpus": 2000,
                                              "manual_expert_snapshot_count": 5,
                                              "prior_checkpoint_lookback": 3})),
            patch("crystalos.graphs.insights.walk_parent_chain", new=AsyncMock(return_value=[])),
            patch("crystalos.graphs.insights._load_response_meta_in_window",
                  new=AsyncMock(return_value=[])),
            patch("crystalos.graphs.insights._load_recent_snapshots", new=AsyncMock(return_value=[])),
        ):
            out = await node_resolve_context(_base_state(profile=INSIGHT_PROFILE_MANUAL_EXPERT))
        assert out["skip_run"] is True
        assert out["skip_reason"] == "empty_window"


# ── node_publish_manual ───────────────────────────────────────────────────────

class TestNodePublishManual:
    @pytest.mark.asyncio
    async def test_writes_report_and_v2_checkpoint_no_supersede(self):
        # Capture every SQL string executed to assert no automated supersede.
        all_sql: list[str] = []

        async def _wcb(blob, org_id, survey_id, ckpt_id):
            return f"/tmp/{ckpt_id}.json"

        # Cursor for insight_reports INSERT ... RETURNING id, and checkpoint number.
        report_cur = _Cursor([
            (_desc("id"), [("report-123",)]),  # insight_reports insert returns id
        ])

        # Patch _write_checkpoint_v2 + _next_checkpoint_number so we don't need full v2 mock.
        state = {
            "survey_id": "s1", "org_id": "org-1", "run_id": "run-1",
            "profile": INSIGHT_PROFILE_MANUAL_EXPERT, "actor": "user:42",
            "report_label": "Q1 review", "report_id": None,
            "window_start": datetime(2026, 1, 1, tzinfo=timezone.utc),
            "window_end": datetime(2026, 2, 1, tzinfo=timezone.utc),
            "insights": [
                {"layer": "descriptive", "category": "report.executive_summary",
                 "headline": "Exec", "narrative": "Summary text",
                 "trust_score": 80, "citations_json": [{"response_id": "r1", "quote": "q"}]},
            ],
            "metrics": {"nps": {"score": 42}, "csat": {}, "total_responses": 100},
            "topics": [{"name": "Billing", "volume": 10}],
            "sample_ids": {"r1", "r2"}, "sample_stats": {"corpus_size": 2, "sampled": 2},
            "metric_snapshots": [], "prior_checkpoints": [], "delta_from_prior": None,
            "config_override": {},
        }

        def _track_pool():
            conn = _Conn(report_cur)
            orig_execute = conn.execute
            async def tracked(sql, params=None):
                all_sql.append(sql)
                return await orig_execute(sql, params)
            conn.execute = tracked

            # Also track cursor execute calls so INSERT INTO insight_reports is captured.
            orig_cursor = conn.cursor
            def _tracked_cursor():
                cur = orig_cursor()
                orig_cur_execute = cur.execute
                async def _track_cur_execute(sql, params=None):
                    all_sql.append(sql)
                    return await orig_cur_execute(sql, params)
                cur.execute = _track_cur_execute
                return cur
            conn.cursor = _tracked_cursor

            pool = MagicMock()
            pool.connection = MagicMock(return_value=conn)
            return pool

        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.graphs.insights._emit_event", new=AsyncMock()),
            patch("crystalos.graphs.insights.write_checkpoint_blob", new=AsyncMock(side_effect=_wcb)),
            patch("crystalos.graphs.insights._append_metric_snapshot", new=AsyncMock()),
            patch("crystalos.graphs.insights._next_checkpoint_number", new=AsyncMock(return_value=1)),
            patch("crystalos.graphs.insights._write_checkpoint_v2",
                  new=AsyncMock(return_value="v2ckpt-1")),
            patch("crystalos.graphs.insights.db._pool_conn", side_effect=_track_pool),
        ):
            out = await node_publish_manual(state)

        assert out["report_id"] == "report-123"
        assert out["manual_report_url"].endswith("/reports/report-123")
        # Must NOT supersede automated insights.
        assert not any("UPDATE insights" in s and "superseded_at" in s for s in all_sql)
        # Must INSERT an insight_reports row.
        assert any("INSERT INTO insight_reports" in s for s in all_sql)

    @pytest.mark.asyncio
    async def test_uses_precreated_report_id(self):
        async def _wcb(blob, org_id, survey_id, ckpt_id):
            return f"/tmp/{ckpt_id}.json"
        cur = _Cursor([])  # no RETURNING needed — report_id preset
        state = {
            "survey_id": "s1", "org_id": "org-1", "run_id": "run-1",
            "profile": INSIGHT_PROFILE_MANUAL_QUICK, "actor": "user:42",
            "report_id": "pre-existing-id", "config_override": {},
            "window_start": None, "window_end": None,
            "insights": [{"layer": "descriptive", "category": "report.executive_summary",
                          "headline": "H", "narrative": "N", "trust_score": 70,
                          "citations_json": []}],
            "metrics": {"nps": {}, "csat": {}, "total_responses": 10},
            "topics": [], "sample_ids": {"r1"}, "sample_stats": {},
            "metric_snapshots": [], "prior_checkpoints": [], "delta_from_prior": None,
        }
        with (
            patch("crystalos.graphs.insights._update_heartbeat", new=AsyncMock()),
            patch("crystalos.graphs.insights._emit_event", new=AsyncMock()),
            patch("crystalos.graphs.insights.write_checkpoint_blob", new=AsyncMock(side_effect=_wcb)),
            patch("crystalos.graphs.insights._append_metric_snapshot", new=AsyncMock()),
            patch("crystalos.graphs.insights._next_checkpoint_number", new=AsyncMock(return_value=2)),
            patch("crystalos.graphs.insights._write_checkpoint_v2", new=AsyncMock(return_value="v2-2")),
            patch("crystalos.graphs.insights.db._pool_conn", return_value=_pool_for(cur)),
        ):
            out = await node_publish_manual(state)
        assert out["report_id"] == "pre-existing-id"
