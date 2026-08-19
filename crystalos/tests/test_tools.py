"""Tests for `crystal/tools.py::dispatch_tool`'s error contract.

`dispatch_tool` must always return a dict — never raise — matching the
contract already guaranteed by `lib/tool_dispatcher.py::ToolDispatcher.dispatch()`.
"""
from __future__ import annotations

import pytest

from crystalos.crystal import tools as crystal_tools
from crystalos.crystal.context import CrystalContext
from crystalos.crystal.tools import dispatch_tool

from .conftest import assert_tool_ok


def make_ctx(**overrides) -> CrystalContext:
    defaults = dict(org_id="org-1", user_id="user-1", survey_id="survey-1", scope="survey")
    defaults.update(overrides)
    return CrystalContext(**defaults)


@pytest.mark.asyncio
async def test_dispatch_tool_catches_raising_executor(monkeypatch):
    """A raising executor must not propagate — dispatch_tool returns an error dict."""

    async def broken_executor(ctx, params):
        raise ValueError("boom")

    monkeypatch.setitem(crystal_tools.TOOL_EXECUTORS, "broken_tool", broken_executor)

    result = await dispatch_tool("broken_tool", make_ctx(), {})

    assert result == {"error": "boom", "tool": "broken_tool"}


@pytest.mark.asyncio
async def test_dispatch_tool_successful_executor_unchanged(monkeypatch):
    """A successful executor's return value is passed through unchanged."""

    async def ok_executor(ctx, params):
        return {"data": "ok", "org_id": ctx.org_id}

    monkeypatch.setitem(crystal_tools.TOOL_EXECUTORS, "ok_tool", ok_executor)

    result = await dispatch_tool("ok_tool", make_ctx(org_id="org-42"), {"foo": "bar"})

    assert result == {"data": "ok", "org_id": "org-42"}
    assert_tool_ok(result, "ok_tool")


@pytest.mark.asyncio
async def test_dispatch_tool_unknown_tool_unaffected():
    """The 'Unknown tool' branch is unaffected by the new try/except."""

    result = await dispatch_tool("this_tool_does_not_exist", make_ctx(), {})

    assert result == {"error": "Unknown tool: this_tool_does_not_exist"}


@pytest.mark.asyncio
async def test_dispatch_tool_metrics_recorded_on_failure(monkeypatch):
    """Metrics (crystal_tool_duration_seconds) are still recorded even when the executor raises."""

    async def broken_executor(ctx, params):
        raise RuntimeError("kaboom")

    monkeypatch.setitem(crystal_tools.TOOL_EXECUTORS, "broken_tool_metrics", broken_executor)

    observed = {}

    class FakeHistogram:
        def labels(self, **kwargs):
            return self

        def observe(self, value):
            observed["called"] = True

    monkeypatch.setattr(crystal_tools, "crystal_tool_duration_seconds", FakeHistogram())

    result = await dispatch_tool("broken_tool_metrics", make_ctx(), {})

    assert result == {"error": "kaboom", "tool": "broken_tool_metrics"}
    assert observed.get("called") is True
