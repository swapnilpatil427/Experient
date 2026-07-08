"""Central namespace for all Redis keys — enforces brand isolation.

All Redis key construction goes through the K class. No raw f-string key
construction anywhere else in the codebase.

Brand-namespaced keys follow the pattern:
    brand:{brand_id}:<service>:<org>:<resource>

When brand_id is None (first-party Experient orgs), the namespace is "global".
"""
from __future__ import annotations


class K:
    """Every Redis key in CrystalOS goes through this class.

    Usage:
        key = K.rate_limit(ctx.brand.brand_id if ctx.brand else None, ctx.org_id)
        key = K.semantic_cache(brand_id, org_id, hash_str)
    """

    @staticmethod
    def _ns(brand_id: str | None) -> str:
        """Return the brand namespace prefix."""
        return f"brand:{brand_id}" if brand_id else "global"

    @classmethod
    def rate_limit(cls, brand_id: str | None, org_id: str) -> str:
        """Redis key for per-org rate limiting within a brand namespace."""
        return f"{cls._ns(brand_id)}:crystal:{org_id}:rpm"

    @classmethod
    def semantic_cache(cls, brand_id: str | None, org_id: str, key_hash: str) -> str:
        """Redis key for semantic query cache, brand-isolated."""
        return f"{cls._ns(brand_id)}:semantic_cache:{org_id}:{key_hash}"

    @classmethod
    def survey_facts(cls, brand_id: str | None, org_id: str, survey_id: str) -> str:
        """Redis key for cached survey facts blob."""
        return f"{cls._ns(brand_id)}:survey_facts:{org_id}:{survey_id}"

    @classmethod
    def progressive_tier(cls, brand_id: str | None, survey_id: str, tier: str) -> str:
        """Redis dedup key for progressive tier triggers — prevents duplicate runs."""
        return f"{cls._ns(brand_id)}:tier:{survey_id}:{tier}"

    @classmethod
    def thread_lock(cls, brand_id: str | None, survey_id: str, org_id: str) -> str:
        """Redis key for Crystal thread mutation lock."""
        return f"{cls._ns(brand_id)}:thread_lock:{org_id}:{survey_id}"

    @classmethod
    def ai_trigger_armed(cls, brand_id: str | None, survey_id: str, trigger_type: str, signal_key: str = "_") -> str:
        """Redis key for AI-trigger hysteresis 'armed' state (Xperiq Actions Wave 3).

        `signal_key` disambiguates multiple concurrent signals of the same
        trigger_type on one survey (e.g. one `anomaly_detected` armed-key per
        metric name, one `new_theme_detected` armed-key per topic name) —
        defaults to '_' for triggers that are inherently survey-scoped singular
        (sentiment_spike). See lib/ai_triggers.py for read/write helpers.
        """
        return f"{cls._ns(brand_id)}:ai_trigger_armed:{survey_id}:{trigger_type}:{signal_key}"
