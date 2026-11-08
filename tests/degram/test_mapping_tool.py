"""Mapping from a DeGram chat session (DG plan 1303-33, D-119..D-121).

The agent tool ``degram_mapping`` starts a session and proposes answers; only the user's click in the chat card
commits, so the tool has no apply action and never reaches DG's apply route. Answers the agent proposed are marked
(D-121) in what the panel and the card read, and the mark survives a runtime restart."""

from __future__ import annotations

import json

import pytest

import tui_gateway.server as server

from .conftest import PROJECT
from .test_mapping import BASE, SESSION, SID, FakeRevit

QUESTION = SESSION["questions"][0]["questionId"]
OPTION = SESSION["questions"][0]["options"][0]["optionId"]


def _answered(answer_id: str) -> dict:
    return {**SESSION, "answers": [{"answerId": answer_id, "questionId": QUESTION, "optionId": OPTION,
                                    "decidedAt": "2026-11-07T11:00:00Z", "items": [], "undoable": True}]}


def _tool(args):
    from tools.degram_tools import _mapping

    return json.loads(_mapping(args))


def _rpc(method, params):
    return server.handle_request({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})["result"]


@pytest.fixture
def revit(rt, monkeypatch):
    fake = FakeRevit()
    monkeypatch.setattr(rt.mapping, "_revit", fake)
    return fake


def test_the_agent_tool_cannot_commit_a_batch(rt, dg):
    from tools.degram_tools import MAPPING_ACTIONS

    assert "apply" not in MAPPING_ACTIONS
    refused = _tool({"action": "apply", "sessionId": SID})
    assert refused["status"] == "refused" and refused["code"] == "BAD_ACTION"
    assert dg.requests == []


def test_start_reads_the_filters_in_revit_and_names_the_card(rt, revit):
    """D-123: the filters that are on reach the connector as they are; the card names the new session."""
    revit.handlers["dg_start_mapping"] = {"started": True, "sessionId": "ms-rooms", "message": "DG: 224 read",
                                          "scope": "filters", "read": 224, "matched": 224, "remaining": 0}
    out = _tool({"action": "start", "app": "revit", "filters": {"view": "active", "categories": ["OST_Rooms"]}})
    assert revit.calls[0]["arguments"] == {"filters": {"view": "active", "categories": ["OST_Rooms"]}}
    assert out["status"] == "ok" and out["scope"] == "filters" and "continue" not in out
    assert out["card"] == {"app": "revit", "sessionId": "ms-rooms", "project": PROJECT}


def test_an_over_limit_start_tells_the_agent_how_to_continue(rt, revit):
    """D-124: remaining elements are reported and the agent is told to offer the continuation."""
    revit.handlers["dg_start_mapping"] = {"started": True, "sessionId": "ms-1", "scope": "filters", "read": 100,
                                          "matched": 250, "remaining": 150, "lastElementId": 9001}
    out = _tool({"action": "start", "app": "revit", "filters": {}, "limit": 100})
    assert revit.calls[0]["arguments"] == {"filters": {}, "limit": 100}
    assert (out["matched"], out["remaining"], out["lastElementId"]) == (250, 150, 9001)
    assert "after = lastElementId" in out["continue"]
    assert out["card"]["next"] == {"filters": {}, "limit": 100, "after": 9001, "read": 100, "matched": 250,
                                   "remaining": 150}
    _tool({"action": "start", "app": "revit", "filters": {}, "limit": 100, "after": 9001})
    assert revit.calls[1]["arguments"] == {"filters": {}, "limit": 100, "after": 9001}


@pytest.mark.parametrize("args", [{"filters": {"categories": ["Rooms"]}}, {"filters": {"layer": 1}},
                                  {"filters": {}, "limit": 0}, {"filters": {}, "limit": 5001}, {"limit": 10}])
def test_bad_filters_are_refused_before_revit(rt, revit, args):
    out = _tool({"action": "start", "app": "revit", **args})
    assert out["code"] == "BAD_REQUEST" and revit.calls == []


def test_grasshopper_takes_no_filters(rt, revit):
    out = _tool({"action": "start", "app": "grasshopper", "filters": {"categories": ["OST_Rooms"]}})
    assert out["status"] != "ok" and revit.calls == []


def test_the_filter_lists_come_from_the_model(rt, revit):
    revit.handlers["dg_list_mapping_categories"] = {"status": "ok", "categories": [
        {"name": "OST_Rooms", "label": "Помещения", "count": 224}]}
    revit.handlers["dg_list_mapping_views"] = {"status": "ok", "views": [{"id": 41, "name": "Level 1", "type": "FloorPlan"}]}
    out = _tool({"action": "filters"})
    assert out["categories"] == [{"name": "OST_Rooms", "label": "Помещения", "count": 224}]
    assert out["views"] == [{"id": 41, "name": "Level 1", "type": "FloorPlan"}]
    assert _rpc("degram.mapping.filters", {"app": "revit"})["categories"][0]["count"] == 224


def test_an_agent_answer_is_marked_until_it_is_undone_and_survives_a_restart(rt, dg):
    from degram_variant import runtime

    dg.routes[f"POST {BASE}/{SID}/decisions"] = (200, {"decisions": [], "profiles": [], "session": _answered("A-7")})
    out = _tool({"action": "answer", "sessionId": SID, "questionId": QUESTION, "optionId": OPTION})
    assert out["status"] == "ok" and out["answerId"] == "A-7" and out["card"]["sessionId"] == SID
    assert all("/apply" not in r["path"] for r in dg.requests)

    dg.routes[f"{BASE}/{SID}"] = (200, _answered("A-7"))
    runtime.reset()
    assert _rpc("degram.mapping.session", {"sessionId": SID})["session"]["agentAnswerIds"] == ["A-7"]

    dg.routes[f"POST {BASE}/{SID}/undo"] = (200, SESSION)
    assert _rpc("degram.mapping.undo", {"sessionId": SID, "answerId": "A-7"})["session"]["agentAnswerIds"] == []
    dg.routes[f"{BASE}/{SID}"] = (200, _answered("A-7"))
    assert _rpc("degram.mapping.session", {"sessionId": SID})["session"]["agentAnswerIds"] == []


def test_a_users_own_answer_is_not_marked(rt, dg):
    dg.routes[f"POST {BASE}/{SID}/decisions"] = (200, {"decisions": [], "profiles": [], "session": _answered("A-8")})
    reply = _rpc("degram.mapping.answer", {"sessionId": SID, "questionId": QUESTION, "optionId": OPTION})
    assert reply["session"]["agentAnswerIds"] == []


def test_the_gateway_start_passes_the_filters_to_revit(rt, revit):
    revit.handlers["dg_start_mapping"] = {"started": True, "sessionId": "ms-walls", "scope": "filters", "read": 3,
                                          "matched": 3, "remaining": 0, "lastElementId": 77}
    reply = _rpc("degram.mapping.start", {"app": "revit", "filters": {"categories": ["OST_Walls"]}, "limit": 3})
    assert revit.calls[0]["arguments"] == {"filters": {"categories": ["OST_Walls"]}, "limit": 3}
    assert (reply["scope"], reply["matched"], reply["remaining"], reply["lastElementId"]) == ("filters", 3, 0, 77)
