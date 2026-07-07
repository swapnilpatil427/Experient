"""Unit tests for lib/constants.py's environment-tiered defaults.

Env-tiered constants are computed at MODULE IMPORT time from os.environ, so
testing a given tier requires setting AGENTS_ENV before a fresh import.
importlib.reload() re-runs that top-level tiering logic against whatever
AGENTS_ENV is currently set.

Deliberately does NOT use the `monkeypatch` fixture for the env vars: its
auto-revert happens at fixture TEARDOWN, whose relative order against this
file's own autouse cleanup fixture (below) isn't guaranteed — an earlier
version of this file relied on that ordering and leaked a tier (e.g.
AGENTS_ENV="dev-paid") into every OTHER test file that imports
crystalos.lib.constants for the rest of the pytest session, since a bare
`importlib.reload(constants)` re-reads WHATEVER os.environ says at the
moment it runs, not whatever it said when the test started. Snapshotting
and restoring the exact pre-test os.environ ourselves removes that
ordering dependency entirely.
"""
import importlib
import os

import pytest

import crystalos.lib.constants as constants


def _reload_with_env(agents_env: str | None, **extra_env: str) -> constants:
    """Set AGENTS_ENV (and any override env vars) then reload constants.py
    so its top-level env-tiering logic re-runs against the new environment."""
    if agents_env is None:
        os.environ.pop("AGENTS_ENV", None)
    else:
        os.environ["AGENTS_ENV"] = agents_env
    for key, value in extra_env.items():
        os.environ[key] = value
    importlib.reload(constants)
    return constants


@pytest.fixture(autouse=True)
def _restore_environ_and_constants_after_test():
    """Snapshot the full environment before each test and restore it exactly
    afterward, THEN reload constants.py against the restored environment —
    so this shared, process-wide-cached module is back to its pre-test tier
    before any other test file runs, regardless of fixture teardown order."""
    original_environ = dict(os.environ)
    yield
    os.environ.clear()
    os.environ.update(original_environ)
    importlib.reload(constants)


class TestTopicDiscoveryMinClusterSizeTiering:
    """Regression test (2026-07-07, customer-reported): a survey seeded with
    auto-generated sample responses (agents/response_generator.py explicitly
    prompts for "realistic, DISTINCT synthetic responses") almost never
    produces 5+ near-duplicate embeddings — the flat min_cluster_size=5 bar
    meant topics_discovered stayed at 0 sweep after sweep in dev/testing,
    indistinguishable from discovery being broken. dev/local now relaxes to
    2 (bootstrap's own exploratory-first-pass floor); prod/staging keep the
    original conservative bar untouched."""

    def test_dev_default_relaxes_to_two(self):
        c = _reload_with_env("dev")
        assert c.DEFAULT_TOPIC_DISCOVERY_MIN_CLUSTER_SIZE == 2

    def test_unset_agents_env_defaults_to_dev_tier(self):
        c = _reload_with_env(None)
        assert c.DEFAULT_TOPIC_DISCOVERY_MIN_CLUSTER_SIZE == 2

    def test_dev_paid_is_a_medium_tier(self):
        c = _reload_with_env("dev-paid")
        assert c.DEFAULT_TOPIC_DISCOVERY_MIN_CLUSTER_SIZE == 3

    def test_staging_keeps_the_conservative_bar(self):
        c = _reload_with_env("staging")
        assert c.DEFAULT_TOPIC_DISCOVERY_MIN_CLUSTER_SIZE == 5

    def test_prod_keeps_the_conservative_bar(self):
        c = _reload_with_env("prod")
        assert c.DEFAULT_TOPIC_DISCOVERY_MIN_CLUSTER_SIZE == 5

    def test_explicit_env_var_override_wins_regardless_of_tier(self):
        c = _reload_with_env("prod", DEFAULT_TOPIC_DISCOVERY_MIN_CLUSTER_SIZE="9")
        assert c.DEFAULT_TOPIC_DISCOVERY_MIN_CLUSTER_SIZE == 9


class TestTopicDiscoverySimilarityThresholdTiering:
    """Same incident, same fix shape as the min-cluster-size tiering above —
    dev/local relaxes TOPIC_DISCOVERY_SIMILARITY_THRESHOLD to exactly
    TOPIC_ASSIGNMENT_THRESHOLD (0.72), the same bar bootstrap's own
    exploratory first clustering pass already uses; prod/staging keep the
    original 0.80."""

    def test_dev_default_relaxes_to_assignment_threshold(self):
        c = _reload_with_env("dev")
        assert c.TOPIC_DISCOVERY_SIMILARITY_THRESHOLD == c.TOPIC_ASSIGNMENT_THRESHOLD == 0.72

    def test_dev_paid_is_a_medium_tier(self):
        c = _reload_with_env("dev-paid")
        assert c.TOPIC_DISCOVERY_SIMILARITY_THRESHOLD == 0.75

    def test_staging_keeps_the_conservative_bar(self):
        c = _reload_with_env("staging")
        assert c.TOPIC_DISCOVERY_SIMILARITY_THRESHOLD == 0.80

    def test_prod_keeps_the_conservative_bar(self):
        c = _reload_with_env("prod")
        assert c.TOPIC_DISCOVERY_SIMILARITY_THRESHOLD == 0.80

    def test_prod_discovery_threshold_is_still_stricter_than_assignment(self):
        """The original invariant this constant was split off to protect
        (2026-07-04) — a new, permanent, LLM-named topic is a costlier
        mistake than a nudge to an existing centroid — must still hold in
        prod/staging, even though dev/local now deliberately relaxes it."""
        c = _reload_with_env("prod")
        assert c.TOPIC_DISCOVERY_SIMILARITY_THRESHOLD > c.TOPIC_ASSIGNMENT_THRESHOLD

    def test_explicit_env_var_override_wins_regardless_of_tier(self):
        c = _reload_with_env("prod", TOPIC_DISCOVERY_SIMILARITY_THRESHOLD="0.65")
        assert c.TOPIC_DISCOVERY_SIMILARITY_THRESHOLD == 0.65
