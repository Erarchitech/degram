"""Restate from the Model Viewer (Phase 1303-29, D-97): DeGram reads what to send from DG and sends it through its own
channels: the DG Revit connector's MCP tool ``dg_restate`` or the Grasshopper canvas bridge's ``restate_parameters``.
The DG backend, the canvas listener and the Revit client are fakes; no Rhino, no Revit, no DG stack."""

from __future__ import annotations

import pytest

from degram_variant import gh_bridge
from degram_variant.lockdown import ALLOWED_RPC_METHODS

from .conftest import PROJECT, TOKEN
from .fakes import gh_error
from .test_mapping import FakeRevit, refusal, rpc

STATE = "OS_0123456789abcdef"
PATH = f"/data-service/validation/restate/{PROJECT}/{STATE}"
POINT = {"uniqueId": "box", "kind": "point", "point": [1.0, 2.0, 0.0], "rotation": 0.5}
LINE = {"uniqueId": "wall", "kind": "curve", "points": [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0]]}
REPORT = {"moved": 2, "unchanged": 1, "skipped": 0, "missing": 0, "failed": 0, "details": []}


@pytest.fixture
def revit(rt, monkeypatch):
    fake = FakeRevit()
    monkeypatch.setattr(rt.mapping, "_revit", fake)
    return fake


def test_a_revit_state_goes_to_the_connector_tool_with_the_recorded_placements(rt, dg, revit):
    dg.routes[PATH] = (200, {"connector": "revit", "stateId": STATE, "label": "Mapping · House",
                             "placements": [LINE, POINT]})
    revit.handlers["dg_restate"] = {"status": "ok", "report": REPORT}
    reply = rpc("degram.restate", {"stateId": STATE})["result"]
    assert reply == {"status": "ok", "connector": "revit", "stateId": STATE, "report": REPORT}
    assert revit.calls == [{"tool": "dg_restate", "deadline_s": None,
                            "arguments": {"placements": [LINE, POINT], "label": "Mapping · House"}}]
    (req,) = dg.requests
    assert req["method"] == "GET" and req["path"] == PATH
    assert req["headers"]["Authorization"] == f"Bearer {TOKEN}"


def test_a_grasshopper_state_goes_to_the_canvas_bridge(rt, dg, gh):
    payload = '{"version": "2", "stateId": "DS_1", "paramStates": [{"parameters": [{"parameterId": "H"}]}]}'
    dg.routes[f"/data-service/validation/restate/{PROJECT}/DS_1"] = (
        200, {"connector": "grasshopper", "stateId": "DS_1", "statePayloadJson": payload})
    gh.handlers["restate_parameters"] = {"applied": True, "aborted": False, "reports": [
        {"parameterId": "H", "status": "Applied"}, {"parameterId": "W", "status": "Unchanged"}]}
    reply = rpc("degram.restate", {"stateId": "DS_1"})["result"]
    assert reply == {"status": "ok", "connector": "grasshopper", "stateId": "DS_1",
                     "report": {"applied": True, "aborted": False, "parameters": 2, "details": []}}
    assert gh.requests[-1] == {"type": "restate_parameters", "parameters": {"stateId": "DS_1",
                                                                            "statePayloadJson": payload}}


def test_an_aborted_grasshopper_restate_names_the_blocking_parameters(rt, dg, gh):
    dg.routes[f"/data-service/validation/restate/{PROJECT}/DS_1"] = (
        200, {"connector": "grasshopper", "stateId": "DS_1", "statePayloadJson": "{}"})
    gh.handlers["restate_parameters"] = {"applied": False, "aborted": True, "reports": [
        {"parameterId": "H", "status": "Missing"}, {"parameterId": "W", "status": "WouldApply"}]}
    report = rpc("degram.restate", {"stateId": "DS_1"})["result"]["report"]
    assert report["applied"] is False and report["details"] == ["H: Missing", "W: WouldApply"]


def test_a_state_recorded_before_restate_is_refused_with_the_server_code(rt, dg, revit, gh):
    dg.routes[PATH] = (422, refusal("RESTATE_NOT_AVAILABLE", "recorded before Restate existed"))
    reply = rpc("degram.restate", {"stateId": STATE})
    assert reply["error"]["data"]["code"] == "RESTATE_NOT_AVAILABLE"
    assert revit.calls == [] and gh.commands() == []


def test_an_unreachable_revit_is_a_named_outcome(rt, dg, revit):
    dg.routes[PATH] = (200, {"connector": "revit", "stateId": STATE, "placements": [POINT]})
    reply = rpc("degram.restate", {"stateId": STATE})["result"]  # FakeRevit without a handler: adapter not connected
    assert reply["code"] == "SETUP_INCOMPLETE"


def test_a_busy_canvas_is_a_named_outcome(rt, dg, gh):
    dg.routes[f"/data-service/validation/restate/{PROJECT}/DS_1"] = (
        200, {"connector": "grasshopper", "stateId": "DS_1", "statePayloadJson": "{}"})
    gh.handlers["restate_parameters"] = gh_error("BUSY")
    assert rpc("degram.restate", {"stateId": "DS_1"})["result"]["code"] == "BUSY"


@pytest.mark.parametrize("params", [{}, {"stateId": ""}, {"stateId": "x" * 600}])
def test_a_missing_state_id_is_refused_before_dg(rt, dg, params):
    assert rpc("degram.restate", params)["error"]["data"]["code"] == "BAD_REQUEST"
    assert dg.requests == []


def test_the_method_is_allowed_in_the_locked_variant():
    assert "degram.restate" in ALLOWED_RPC_METHODS


def test_restate_parameters_is_on_the_canvas_allowlist_and_not_a_context_read():
    assert "restate_parameters" in gh_bridge.GH_COMMANDS
    assert "restate_parameters" not in gh_bridge.GH_READ_COMMANDS
