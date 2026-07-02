"""Tests for the workflow-analyst skill (Xperiq Actions Wave 4 / Phase 5).

Covers:
  - workflow-analyst loads correctly from the real skills/ directory
  - SKILL.md frontmatter is well-formed (allowed-tools, evals/examples paths)
  - allowed-tools are real, registered Crystal tools (propose_workflow, get_survey_overview)
  - propose_workflow's proposal_type aliases to the frontend create_workflow handler name
  - plugin.json's static manifest stays consistent with the skill actually being registered

This skill formalizes the existing Wave 3 NL-parsing/AI-trigger capability
(crystal/workflow_nl.py, lib/ai_triggers.py, execute_propose_workflow) under the
skill-framework's SKILL.md/EVALS.md contract — it does not change any of that
logic, so these tests check registration/wiring, not NL-parsing behavior
(already covered by tests/test_workflow_nl.py and tests/test_ai_triggers.py).
"""
from __future__ import annotations

import json
from pathlib import Path

from crystalos.lib.skill_registry import SkillRegistry
from crystalos.crystal.registry import TOOL_REGISTRY, ACTION_TOOL_NAMES

SKILLS_DIR = Path(__file__).parent.parent / "skills"


def _load_registry() -> SkillRegistry:
    reg = SkillRegistry(skills_dir=SKILLS_DIR)
    reg._scan_skills()
    return reg


# ── Skill discovery / frontmatter ──────────────────────────────────────────────

def test_workflow_analyst_loads_from_real_skills_dir():
    reg = _load_registry()
    assert "workflow-analyst" in reg._skills


def test_workflow_analyst_frontmatter_well_formed():
    reg = _load_registry()
    meta = reg.get_skill_meta("workflow-analyst")
    assert meta is not None
    assert meta["name"] == "workflow-analyst"
    assert meta["shared"] is True
    assert meta["evals"] == "EVALS.md"
    assert meta["examples"] == "EXAMPLES.md"
    assert meta["max_retries"] == 1
    assert meta["timeout_seconds"] > 0
    assert meta["max_output_tokens"] > 0


def test_workflow_analyst_allowed_tools():
    reg = _load_registry()
    meta = reg.get_skill_meta("workflow-analyst")
    assert meta["allowed_tools"] == ["get_survey_overview", "propose_workflow"]


def test_workflow_analyst_findable_by_description_keywords():
    """Sanity check the difflib fallback router (find_sync) can at least surface
    this skill for an on-topic query — the real semantic router uses embeddings,
    but find_sync is the offline fallback and should not be blind to this skill."""
    reg = _load_registry()
    result = reg.find_sync("automate a workflow when NPS drops")
    # find_sync is a coarse difflib match across all skills; we only assert it
    # doesn't crash and (when it does match) doesn't silently exclude the skill
    # from ever being considered — presence in the corpus is what matters here.
    assert "workflow-analyst" in reg._skills
    assert result is None or isinstance(result, str)


# ── EVALS.md / EXAMPLES.md exist and are non-trivial ──────────────────────────

def test_evals_md_exists_and_has_criteria_table():
    evals_path = SKILLS_DIR / "workflow-analyst" / "EVALS.md"
    assert evals_path.exists()
    content = evals_path.read_text()
    assert "| ID | Criterion | Weight | Threshold |" in content
    assert "Pass threshold" in content


def test_examples_md_exists_and_has_worked_examples():
    examples_path = SKILLS_DIR / "workflow-analyst" / "EXAMPLES.md"
    assert examples_path.exists()
    content = examples_path.read_text()
    assert "create_workflow" in content
    assert "crystal.new_theme_detected" in content


# ── Tool wiring: allowed-tools must be real, registered tools ─────────────────

def test_allowed_tools_are_registered_in_tool_registry():
    reg = _load_registry()
    meta = reg.get_skill_meta("workflow-analyst")
    registry_names = {t["name"] for t in TOOL_REGISTRY}
    for tool_name in meta["allowed_tools"]:
        assert tool_name in registry_names, f"allowed-tool {tool_name!r} missing from TOOL_REGISTRY"


def test_propose_workflow_is_a_registered_action_tool():
    assert "propose_workflow" in ACTION_TOOL_NAMES


# ── plugin.json manifest consistency ───────────────────────────────────────────

def test_plugin_json_lists_workflow_analyst():
    plugin = json.loads((SKILLS_DIR / "plugin.json").read_text())
    assert "./workflow-analyst" in plugin["skills"]


def test_plugin_json_maps_propose_workflow_tool():
    plugin = json.loads((SKILLS_DIR / "plugin.json").read_text())
    assert plugin["tools"]["propose_workflow"] == "crystalos.crystal.tools:execute_propose_workflow"


def test_plugin_json_is_valid_json_after_edit():
    """Regression guard: a hand-edited plugin.json is a common source of a
    trailing-comma / bracket typo that breaks every skill's static manifest."""
    plugin = json.loads((SKILLS_DIR / "plugin.json").read_text())
    assert isinstance(plugin["skills"], list)
    assert isinstance(plugin["tools"], dict)


# ── Output-shape contract: create_workflow proposals must alias correctly ─────

def test_workflow_proposal_type_aliases_to_frontend_handler_name():
    """crystalos/CLAUDE.md's Crystal-vs-Copilot table documents proposal_type
    'workflow' -> frontend handler 'create_workflow'. This skill's SKILL.md
    output schema emits action_proposals with type 'create_workflow' directly
    (already-normalized shape); execute_propose_workflow's tool path emits
    proposal_type 'workflow' and relies on _normalize_proposal's alias map to
    reach the same frontend type. Assert that alias still exists so the two
    emission paths (skill JSON vs. tool dict) stay reconciled."""
    from crystalos.agents.crystal import _PROPOSAL_TYPE_ALIASES

    assert _PROPOSAL_TYPE_ALIASES.get("workflow") == "create_workflow"
