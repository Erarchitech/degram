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
    import tools.degram_tools  # registers the real handler
    from tools.registry import registry

    result = registry.dispatch("degram_mapping", args)
    return json.loads(result) if isinstance(result, str) else result


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


def test_agent_schema_declares_only_the_exact_proposal_actions(rt):
    import tools.degram_tools
    from tools.registry import registry

    params = registry.get_schema("degram_mapping")["parameters"]
    assert set(params["properties"]["action"]["enum"]) == {
        "filters", "sessions", "start", "session", "answer", "undo",
        "advanced", "overview", "selection", "propose", "mode"}
    assert params["additionalProperties"] is False
    assert not {"intentId", "confirmed", "byAgent", "actor", "project", "model", "url"} & set(params["properties"])
    assert params["properties"]["answerSummary"]["type"] == "object"


@pytest.mark.parametrize("action", ["approve", "skip", "apply", "preview", "clear", "clear-preview", "confirm",
                                  "confirmIntent", "derive", "answers"])
def test_protected_actions_refused_through_real_registry(rt, dg, revit, action):
    out = _tool({"action": action, "sessionId": SID, "confirmed": True, "byAgent": False})
    assert out["status"] == "refused" and out["code"] == "BAD_ACTION"
    assert dg.requests == [] and revit.calls == []


@pytest.mark.parametrize("extra", [{"confirmed": True}, {"byAgent": False}, {"intentId": "hi-fake"},
                                  {"project": "other"}, {"url": "http://example.invalid"}])
def test_proof_and_scope_flags_are_refused_before_any_service_call(rt, dg, extra):
    out = _tool({"action": "advanced", "sessionId": SID, **extra})
    assert out["status"] == "refused" and out["code"] == "BAD_REQUEST"
    assert dg.requests == []


@pytest.mark.parametrize("entry", ["tool", "service"])
@pytest.mark.parametrize("shape", ["question", "type", "detail", "pending"])
def test_agent_and_direct_ordinary_undo_cannot_remove_advanced_answer(rt, dg, entry, shape):
    from degram_variant.dg_client import DgRefused

    answer = {"answerId": "A-protected", "questionId": QUESTION, "optionId": OPTION}
    session = {**SESSION, "answers": [answer]}
    if shape == "question":
        answer["questionId"] = " %2561dvanced%253Adefinition "
    elif shape == "type":
        answer["type"] = "advanced-answer"
    elif shape == "detail":
        answer["advancedAnswer"] = {"definitionId": "MD-0123456789ab"}
    else:
        session["advanced"] = {"pending": [{"answerId": "A-protected"}]}
    dg.routes[f"{BASE}/{SID}"] = (200, session)
    dg.routes[f"POST {BASE}/{SID}/undo"] = (200, SESSION)
    if entry == "tool":
        out = _tool({"action": "undo", "sessionId": SID, "answerId": "A-protected"})
        assert out["status"] == "refused" and out["code"] == "MAPPING_PROTECTED_ANSWER"
    else:
        with pytest.raises(DgRefused) as exc:
            rt.mapping.undo(SID, "A-protected")
        assert exc.value.code == "MAPPING_PROTECTED_ANSWER"
    assert not any(r["method"] == "POST" for r in dg.requests)


@pytest.mark.parametrize("entry", ["tool", "service"])
def test_ordinary_undo_still_works(rt, dg, entry):
    dg.routes[f"{BASE}/{SID}"] = (200, _answered("A-ordinary"))
    dg.routes[f"POST {BASE}/{SID}/undo"] = (200, SESSION)
    out = (_tool({"action": "undo", "sessionId": SID, "answerId": "A-ordinary"}) if entry == "tool"
           else rt.mapping.undo(SID, "A-ordinary"))
    assert (out.get("status") == "ok") if entry == "tool" else out["sessionId"] == SID
    assert dg.requests[-1]["body"]["answerId"] == "A-ordinary"


@pytest.mark.parametrize("kind,recipe", [
    ("derived", {"recipe": "building-envelope", "version": 1}),
    ("compound", {"recipe": "union-members", "version": 1, "members": ["pinned-member"]}),
    ("direct", {"recipe": "selected-elements", "version": 1, "elementIds": ["pinned-member"]}),
])
def test_registry_proposes_each_kind_without_approval_or_native_effect(rt, dg, revit, kind, recipe):
    definition = {"definitionId": "MD-0123456789ab", "classIri": "ex:Building", "mode": "advanced",
                  "head": {"kind": kind, "source": "agent", "version": 2, "status": "draft"},
                  "effective": {"version": 1, "status": "approved"}}
    dg.routes["POST /data-service/mapping/definitions"] = (200, {"definition": definition})
    out = _tool({"action": "propose", "classIri": "ex:Building", "kind": kind, "recipe": recipe,
                 "text": "Grid 1/A, not a height measurement", "answerSummary": {"base": "Grid 1"},
                 "expectedRevision": 1})
    assert out["status"] == "ok" and out["definition"] == definition
    assert out["agentDefinitionClasses"] == ["ex:Building"]
    assert dg.requests[0]["body"]["recipe"] == recipe
    assert dg.requests[0]["body"]["answerSummary"] == {"base": "Grid 1"}
    assert len(dg.requests) == 1 and revit.calls == []
    assert not any(word in dg.requests[0]["path"] for word in ("human-intents", "answers", "apply"))


def test_registry_mode_is_only_a_revisioned_proposal(rt, dg):
    definition = {"definitionId": "MD-0123456789ab", "mode": "advanced",
                  "modeProposal": {"mode": "ordinary", "source": "agent"}, "effective": {"version": 1}}
    dg.routes["POST /data-service/mapping/definitions/mode"] = (200, {"definition": definition})
    out = _tool({"action": "mode", "definitionId": definition["definitionId"], "mode": "ordinary",
                 "expectedRevision": 2, "reason": "prefer ordinary mapping"})
    assert out["status"] == "ok" and out["definition"] == definition
    assert dg.requests[0]["body"]["expectedRevision"] == 2 and len(dg.requests) == 1


def test_registry_advanced_state_keeps_failure_and_draft_separate(rt, dg):
    session = {**SESSION, "advanced": {"definitions": [], "bindings": [
        {"definitionId": "MD-0123456789ab", "resultStatus": "needs-input", "resultHash": None,
         "approved": {"definitionVersion": 1}, "materialization": {"state": "unknown"}}],
        "pending": [], "commit": None}}
    dg.routes[f"{BASE}/{SID}"] = (200, session)
    out = _tool({"action": "advanced", "sessionId": SID})
    assert out["status"] == "ok" and out["bindings"][0]["resultStatus"] == "needs-input"
    assert out["bindings"][0]["approved"] == {"definitionVersion": 1}
    assert out["card"]["sessionId"] == SID
    assert len(dg.requests) == 1 and dg.requests[0]["method"] == "GET"


@pytest.mark.parametrize("answer_id", ["A-unknown", "advanced:MD-0123456789ab", "ＡＤＶＡＮＣＥＤ：test",
                                      "advanced%253Atest"])
def test_unknown_or_protected_undo_id_never_reaches_post(rt, dg, answer_id):
    dg.routes[f"{BASE}/{SID}"] = (200, SESSION)
    out = _tool({"action": "undo", "sessionId": SID, "answerId": answer_id})
    assert out["status"] == "refused"
    assert out["code"] in ("MAPPING_PROTECTED_ANSWER", "MAPPING_ANSWER_NOT_FOUND")
    assert all(r["method"] == "GET" for r in dg.requests)


def test_agent_answer_scope_change_cannot_mark_answer_in_new_profile(rt, dg, monkeypatch):
    from degram_variant.credentials import credentials

    def delayed(*args, **kwargs):
        credentials.clear()
        return _answered("A-delayed")

    monkeypatch.setattr(rt.mapping._dg, "post_mapping_decision", delayed)
    monkeypatch.setattr(rt.mapping._agent, "add", lambda *a: pytest.fail("stale answer was attributed"))
    out = _tool({"action": "answer", "sessionId": SID, "questionId": QUESTION, "optionId": OPTION})
    assert out["code"] == "CANCELLED" and out["reason"] == "SCOPE_CHANGED"
    assert dg.requests == []


def test_undo_scope_change_during_canonical_read_never_posts(rt, dg, monkeypatch):
    from degram_variant.credentials import credentials

    def delayed(*args, **kwargs):
        credentials.clear()
        return _answered("A-ordinary")

    monkeypatch.setattr(rt.mapping._dg, "get_mapping_session", delayed)
    out = _tool({"action": "undo", "sessionId": SID, "answerId": "A-ordinary"})
    assert out["code"] == "CANCELLED" and out["reason"] == "SCOPE_CHANGED"
    assert dg.requests == []


def test_user_rpc_can_still_undo_an_advanced_draft(rt, dg):
    dg.routes[f"POST {BASE}/{SID}/undo"] = (200, SESSION)
    out = _rpc("degram.mapping.undo", {"sessionId": SID, "answerId": "A-protected"})
    assert out["session"]["sessionId"] == SID
    assert dg.requests[0]["body"]["answerId"] == "A-protected"


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
