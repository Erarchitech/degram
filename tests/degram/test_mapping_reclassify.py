"""Batch class correction of a recognised group from the mapping panel (plan 1303-36, D-140, D-141).

Same harness as test_mapping.py: a fake DG backend on loopback HTTP, the real RPC dispatcher and lockdown admission.
"""

from __future__ import annotations

import pytest

from degram_variant.lockdown import ALLOWED_RPC_METHODS

from .test_mapping import BASE, PROJECT, SESSION, SID, refusal, rpc

GROUP = "G-14d98393"
RECOGNISED = [{"groupId": GROUP, "title": "100 elements from Box", "titleRu": "100 элементов из Box", "size": 100,
               "classes": [{"classIri": "ex:Beam", "label": "Beam"}],
               "profiles": [{"profileId": "P-1", "source": "learned", "confirmations": 1, "rejections": 0}],
               "representatives": ["r1"]}]
WITH_RECOGNISED = {**SESSION, "recognised": RECOGNISED,
                   "recognisedClasses": [{"classIri": "ex:Beam", "label": "Beam"},
                                         {"classIri": "ex:OpeningBox", "label": "OpeningBox"}]}


def test_the_exact_name_is_admitted_and_the_agent_tool_gains_no_action():
    assert "degram.mapping.reclassify" in ALLOWED_RPC_METHODS
    assert not [n for n in ALLOWED_RPC_METHODS if "*" in n]
    from tools.degram_tools import MAPPING_ACTIONS

    assert "reclassify" not in MAPPING_ACTIONS


def test_reclassify_reaches_dg_with_the_delegated_token_and_returns_the_panel_session(rt, dg):
    dg.routes[f"POST {BASE}/{SID}/reclassify"] = (200, WITH_RECOGNISED)
    reply = rpc("degram.mapping.reclassify", {"sessionId": SID, "groupId": GROUP, "classIris": ["ex:OpeningBox"]})
    assert reply["result"]["status"] == "ok"
    session = reply["result"]["session"]
    assert session["recognised"] == RECOGNISED and session["recognisedClasses"][1]["label"] == "OpeningBox"
    assert not {"elements", "groups", "parameters", "measures"} & set(session)
    request = dg.requests[-1]
    assert request["body"] == {"project": PROJECT, "groupId": GROUP, "classIris": ["ex:OpeningBox"]}


def test_a_dg_refusal_keeps_its_code_and_status(rt, dg):
    dg.routes[f"POST {BASE}/{SID}/reclassify"] = (404, refusal("MAPPING_GROUP_NOT_FOUND", "no such group"))
    reply = rpc("degram.mapping.reclassify", {"sessionId": SID, "groupId": GROUP, "classIris": ["ex:OpeningBox"]})
    assert reply["error"]["code"] == 4404
    assert reply["error"]["data"] == {"code": "MAPPING_GROUP_NOT_FOUND", "status": 404}


@pytest.mark.parametrize("params", [
    {"groupId": GROUP, "classIris": ["ex:A"]},
    {"sessionId": SID, "classIris": ["ex:A"]},
    {"sessionId": SID, "groupId": GROUP, "classIris": []},
    {"sessionId": SID, "groupId": GROUP, "classIris": ["ex:A"] * 9},
    {"sessionId": SID, "groupId": GROUP, "classIris": [" "]},
])
def test_missing_or_malformed_params_never_reach_dg(rt, dg, params):
    reply = rpc("degram.mapping.reclassify", params)
    assert reply["error"]["code"] in (4000, 4400) or reply["error"]["data"]["code"] == "BAD_REQUEST"
    assert dg.requests == []


def test_it_refuses_outside_variant_degram(rt, monkeypatch):
    monkeypatch.delenv("HERMES_DEGRAM")
    reply = rpc("degram.mapping.reclassify", {"sessionId": SID, "groupId": GROUP, "classIris": ["ex:A"]})
    assert reply["error"]["data"]["code"] == "NOT_DEGRAM"
