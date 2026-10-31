"""DG 1303-31 (D-106): a property check that records a new Design State waits for its name; the agent asks the user
and names it through degram_property_check action 'name'."""

from __future__ import annotations

import json

from .conftest import PROJECT, TOKEN

RUN = "POST /data-service/scripts/property-check/run"
NAME = "POST /data-service/scripts/property-check/chk-1/name"


def _tool(args):
    from tools.degram_tools import _property_check

    return json.loads(_property_check(args))


def test_a_new_design_state_makes_the_agent_ask_for_its_name(rt, dg):
    dg.routes[RUN] = (200, {"finished": False, "nameRequired": True, "checkId": "chk-1", "stateId": "DS_1",
                            "suggestion": {"name": "Добавлены новые отверстия.", "source": "llm"}})
    out = _tool({"action": "run"})
    assert out["status"] == "ok" and out["nameRequired"] is True and out["checkId"] == "chk-1"
    assert out["suggestedName"] == "Добавлены новые отверстия." and "action 'name'" in out["instruction"]
    assert "violations" not in out  # nothing was published or painted


def test_the_name_action_sends_the_confirmed_name_and_reports_the_published_check(rt, dg):
    dg.routes[NAME] = (200, {"finished": True, "status": {"boxes": 4, "violations": [], "messages": []},
                             "summary": {"ok": True}})
    out = _tool({"action": "name", "checkId": "chk-1", "designStateName": "  Свои   отверстия ",
                 "designStateNameSource": "edited"})
    assert out["status"] == "ok" and out["boxes"] == 4 and out["finished"] is True
    assert dg.requests[0]["body"] == {"project": PROJECT, "designStateName": "Свои отверстия",
                                      "designStateNameSource": "edited"}
    assert dg.requests[0]["headers"]["Authorization"] == f"Bearer {TOKEN}"


def test_the_name_action_needs_a_check_id_and_a_name(rt, dg):
    out = _tool({"action": "name", "checkId": "chk-1", "designStateName": "  "})
    assert out["status"] != "ok" and dg.requests == []
