"""CrystalContext — immutable request context passed to every Crystal tool."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Literal


@dataclass(frozen=True)
class BrandContext:
    """Enterprise tenant identity — set once at request boundary, propagated everywhere."""
    brand_id:            str
    brand_name:          str
    brand_persona:       str | None          # "Marriott Insights" — how Crystal introduces itself
    data_region:         Literal["us", "eu", "apac", "ca"]
    plan_tier:           Literal["starter", "growth", "enterprise", "enterprise_plus"]
    permitted_features:  frozenset[str]      # Explicit allowlist from brand contract
    restricted_features: frozenset[str]      # Explicit blocklist
    custom_instructions: str | None          # Brand-specific Crystal behavior addendum
    support_ticket_url:  str | None          # Brand's own support system for bug routing
    feature_request_url: str | None          # Brand's own roadmap system
    max_tool_turns:      int = 10            # Configurable per brand tier
    thread_ttl_days:     int = 7             # Configurable per brand
    progressive_tiers:   tuple[int, ...] = (10, 40, 100, 250)  # Configurable per volume


# Role → default permissions mapping
ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "viewer":      frozenset({"data:read"}),
    "editor":      frozenset({"data:read", "data:export", "survey:write", "workflow:write"}),
    "admin":       frozenset({"data:read", "data:export", "data:pii", "survey:write", "workflow:write", "admin:read"}),
    "brand_admin": frozenset({"data:read", "data:export", "data:pii", "survey:write", "workflow:write", "admin:read", "brand:admin"}),
}


def _resolve_permissions(
    brand: "BrandContext | None",
    role: str,
) -> frozenset[str]:
    """Return effective permissions: role defaults ∩ brand contract."""
    role_perms = ROLE_PERMISSIONS.get(role, frozenset())
    if brand is None:
        return role_perms
    # brand_admin role gets role defaults PLUS any brand-specific permitted features
    if role == "brand_admin":
        combined = role_perms | brand.permitted_features
        return combined - brand.restricted_features
    # For other roles: intersect with brand's permitted features (if non-empty)
    if brand.permitted_features:
        result = role_perms & brand.permitted_features
    else:
        result = role_perms
    return result - brand.restricted_features


@dataclass(frozen=True)
class CrystalContext:
    org_id:          str
    user_id:         str
    survey_id:       str | None
    scope:           Literal["survey", "org", "group", "tag"]
    run_id:          str | None = None
    has_open_text:   bool = True
    tag_ids:         tuple[str, ...] | None = None
    brand:           BrandContext | None = None              # None = first-party Experient org
    user_role:       Literal["viewer", "editor", "admin", "brand_admin"] = "viewer"
    effective_perms: frozenset[str] = field(default_factory=frozenset)
    contact_id:       str | None = None                         # response linked to this contact
    account_id:       str | None = None                         # account grouping
    owner_map:        tuple[tuple[str, str], ...] = ()          # pre-resolved ((dim:val, owner_user_id), ...) — tuple keeps frozen dataclass hashable
    ontology_version: str | None = None                         # for cache invalidation
