"""Mapping sub-tab of «Модели» (Phase 1303-10, 1303-13; 1303-API-CONTRACT.md §2, §3, §7, §8).

The DG mapping routes go to a fake DG backend on loopback HTTP with the delegated token of the bound project; the
Grasshopper commands go to a fake DG Canvas bridge listener; the DG Revit connector's tools go to a fake Revit client
in place of the MCP child. No Rhino, no Revit, no DG stack."""

from __future__ import annotations

from typing import Any

import pytest

import tui_gateway.server as server
from degram_variant import gh_bridge
from degram_variant.dg_client import DgRefused
from degram_variant.mapping import MAX_SHOW_ELEMENTS, REVIT_STATUS_DEADLINE_S, document_key, session_document
from degram_variant.outcomes import BridgeError
from degram_variant.revit_bridge import RevitBridgeClient

from .conftest import PROJECT, TOKEN
from .fakes import free_port, gh_error

BASE = "/data-service/mapping/sessions"
SID = "ms-0123456789ab"
COMPONENT = "24549b0264794f1bb333b7768ab72820"

ITEM = {"itemId": "G-aaaa0001", "kind": "stream", "name": "Panels A", "componentId": COMPONENT, "count": 120,
        "proposal": {"iri": "ex:GlassPanel", "label": "GlassPanel"},
        "alternatives": [{"iri": "ex:BottomTriangularPanel", "label": "BottomTriangularPanel"}], "state": "ambiguous"}
SESSION = {
    "sessionId": SID, "project": PROJECT, "platform": "grasshopper", "label": "tower-facade · 09:00:00",
    "document": "tower-facade", "createdAt": "2026-10-18T09:00:00Z",
    "summary": {"total": 120, "confirmed": 0, "auto": 0, "suggested": 0, "ambiguous": 120, "unmapped": 0,
                "openQuestions": 1},
    "questions": [{"questionId": "Q-0000aaaa", "type": "mapping-or-design", "text": "t", "textRu": "т",
                   "title": "Panels A · 120 elements", "titleRu": "Panels A · 120 элементов", "items": [ITEM],
                   "options": [{"optionId": "class:ex:GlassPanel", "label": "GlassPanel", "roles": ["ex:GlassPanel"]}]}],
    "answers": [], "groups": [{"groupId": "G-aaaa0001", "size": 120}], "elements": [{"nativeId": "gh:x:1"}] * 3,
    "parameters": [], "measures": [], "llm": {"status": "pending"},
}
ROWS = [
    {"sessionId": "ms-new", "label": "tower-facade · 10:00:00", "document": "tower-facade", "platform": "grasshopper",
     "createdAt": "2026-10-18T10:00:00Z", "summary": {"total": 1}, "createdBy": "alice"},
    {"sessionId": "ms-other", "label": "other · 09:30:00", "document": "other", "platform": "grasshopper",
     "createdAt": "2026-10-18T09:30:00Z", "summary": {"total": 2}},
    {"sessionId": "ms-old", "label": "tower-facade · 08:00:00", "platform": "grasshopper",  # older row: no document
     "createdAt": "2026-10-18T08:00:00Z", "summary": {"total": 3}, "appliedAt": "2026-10-18T08:05:00Z"},
]


def refusal(code, message="refused"):
    return {"detail": {"error": message, "hint": "h", "code": code}}


def rpc(method, params=None, rid=1):
    return server.handle_request({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})


class TestDocumentKey:
    @pytest.mark.parametrize("name,key", [("Tower Facade.gh", "tower-facade"), ("tower-facade.ghx", "tower-facade"),
                                          ("v12_Hex (copy).gh", "v12_hex--copy-"), ("Tower.rvt", "tower"),
                                          ("tower-facade", "tower-facade")])
    def test_the_key_follows_the_canvas_reader(self, name, key):
        assert document_key(name) == key

    def test_a_row_without_document_is_matched_by_its_label_prefix(self):
        assert session_document({"label": "Tower Facade · 10:00:00"}) == "tower-facade"
        assert session_document({"label": "no separator"}) == ""
        assert session_document({"document": "tower-facade", "label": "x · y"}) == "tower-facade"


class TestDgClientMapping:
    def test_list_reads_the_bound_project_with_the_bearer_token_only(self, rt, dg):
        dg.routes[BASE] = (200, {"sessions": ROWS})
        assert [r["sessionId"] for r in rt.dg.list_mapping_sessions()] == ["ms-new", "ms-other", "ms-old"]
        (req,) = dg.requests
        assert req["method"] == "GET" and req["path"] == f"{BASE}?project={PROJECT}&limit=20"
        assert req["headers"]["Authorization"] == f"Bearer {TOKEN}"
        assert "Cookie" not in req["headers"]

    def test_get_quotes_the_session_id_and_names_the_project(self, rt, dg):
        dg.routes[f"{BASE}/ms-a%2Fb"] = (200, SESSION)
        assert rt.dg.get_mapping_session("ms-a/b")["sessionId"] == SID
        assert dg.requests[0]["path"] == f"{BASE}/ms-a%2Fb?project={PROJECT}"

    def test_a_decision_posts_project_question_option_and_groups_and_returns_the_session(self, rt, dg):
        dg.routes[f"POST {BASE}/{SID}/decisions"] = (200, {"decisions": [], "profiles": [], "session": SESSION})
        assert rt.dg.post_mapping_decision(SID, "Q-1", "accept-all", ["G-1"])["sessionId"] == SID
        assert dg.requests[0]["body"] == {"project": PROJECT, "questionId": "Q-1", "optionId": "accept-all",
                                          "groupIds": ["G-1"]}
        rt.dg.post_mapping_decision(SID, "Q-1", "none")
        assert "groupIds" not in dg.requests[1]["body"]

    def test_undo_posts_the_answer_id(self, rt, dg):
        dg.routes[f"POST {BASE}/{SID}/undo"] = (200, SESSION)
        assert rt.dg.undo_mapping_answer(SID, "A-1")["sessionId"] == SID
        assert dg.requests[0]["body"] == {"project": PROJECT, "answerId": "A-1"}
        assert dg.requests[0]["headers"]["Authorization"] == f"Bearer {TOKEN}"

    @pytest.mark.parametrize("status", [401, 403])
    def test_a_refused_token_is_access_denied(self, rt, dg, status):
        dg.routes[BASE] = (status, refusal("FORBIDDEN"))
        with pytest.raises(BridgeError) as exc:
            rt.dg.list_mapping_sessions()
        assert exc.value.code == "ACCESS_DENIED"

    @pytest.mark.parametrize("status,code", [(404, "MAPPING_ANSWER_NOT_FOUND"), (409, "MAPPING_SESSION_APPLIED"),
                                             (400, "MAPPING_OPTION_INVALID")])
    def test_a_request_refused_for_what_it_is_carries_the_server_code_and_message(self, rt, dg, status, code):
        dg.routes[f"POST {BASE}/{SID}/undo"] = (status, refusal(code, "the session is applied"))
        with pytest.raises(DgRefused) as exc:
            rt.dg.undo_mapping_answer(SID, "A-1")
        assert (exc.value.status, exc.value.code, exc.value.message) == (status, code, "the session is applied")
        assert len(dg.requests) == 1, "no retry"

    def test_a_refusal_without_a_code_is_named_by_its_status(self, rt, dg):
        dg.routes[f"{BASE}/{SID}"] = (404, {"detail": "Not Found"})
        with pytest.raises(DgRefused) as exc:
            rt.dg.get_mapping_session(SID)
        assert exc.value.code == "HTTP_404" and exc.value.message == "Not Found"

    @pytest.mark.parametrize("status", [500, 302])
    def test_a_server_failure_or_a_redirect_is_dg_unavailable(self, rt, dg, status):
        dg.routes[BASE] = (status, {"detail": "boom"})
        with pytest.raises(BridgeError) as exc:
            rt.dg.list_mapping_sessions()
        assert exc.value.code == "DG_UNAVAILABLE" and exc.value.reason == f"HTTP_{status}"

    def test_the_graph_and_rules_reads_keep_their_404_outcome(self, rt, dg):
        dg.routes[f"/data-service/rules/{PROJECT}"] = (404, refusal("NOT_FOUND"))
        with pytest.raises(BridgeError) as exc:
            rt.dg.get_rules()
        assert exc.value.code == "DG_UNAVAILABLE"

    def test_an_answer_without_a_session_is_malformed(self, rt, dg):
        dg.routes[f"POST {BASE}/{SID}/decisions"] = (200, {"decisions": []})
        with pytest.raises(BridgeError) as exc:
            rt.dg.post_mapping_decision(SID, "Q-1", "none")
        assert exc.value.code == "DG_UNAVAILABLE" and exc.value.reason == "MALFORMED"

    def test_no_credential_is_named(self, rt, dg):
        from degram_variant.credentials import credentials
        credentials.clear()
        with pytest.raises(BridgeError) as exc:
            rt.dg.list_mapping_sessions()
        assert exc.value.code == "CREDENTIALS_MISSING" and dg.requests == []


class TestRpc:
    def test_sessions_of_a_gh_document_use_the_key_the_canvas_names(self, rt, dg, gh):
        dg.routes[BASE] = (200, {"sessions": ROWS})
        gh.handlers["get_mapping_status"] = {"document": "tower-facade", "connector": True, "signedIn": True,
                                             "sessionId": "ms-new", "message": "Map: 1?"}
        reply = rpc("degram.mapping.sessions", {"document": "Something Else.gh", "app": "grasshopper"})["result"]
        assert reply["status"] == "ok" and reply["document"] == "tower-facade"
        assert [s["sessionId"] for s in reply["sessions"]] == ["ms-new", "ms-old"], "newest first, old row by label"
        assert reply["sessions"][0] == {k: ROWS[0][k] for k in
                                        ("sessionId", "label", "document", "platform", "createdAt", "summary")}
        assert reply["sessions"][1]["appliedAt"] == ROWS[2]["appliedAt"]
        assert (reply["connector"], reply["signedIn"], reply["connectorSessionId"]) == (True, True, "ms-new")
        assert "get_mapping_status" in gh.commands()

    def test_without_the_bridge_the_key_is_derived_from_the_document_name(self, rt, dg, monkeypatch):
        dg.routes[BASE] = (200, {"sessions": ROWS})
        monkeypatch.setattr(gh_bridge, "GH_PORT", free_port())
        reply = rpc("degram.mapping.sessions", {"document": "Tower Facade.gh", "app": "grasshopper"})["result"]
        assert reply["document"] == "tower-facade" and len(reply["sessions"]) == 2
        assert reply.get("signedIn") is None

    def test_an_old_canvas_without_the_status_command_falls_back_too(self, rt, dg, gh):
        dg.routes[BASE] = (200, {"sessions": ROWS})
        reply = rpc("degram.mapping.sessions", {"document": "other.gh", "app": "grasshopper"})["result"]
        assert [s["sessionId"] for s in reply["sessions"]] == ["ms-other"]

    def test_a_revit_document_never_asks_the_canvas_and_no_document_lists_everything(self, rt, dg, gh):
        dg.routes[BASE] = (200, {"sessions": ROWS})
        assert rpc("degram.mapping.sessions", {"document": "Tower.rvt", "app": "revit"})["result"]["sessions"] == []
        assert len(rpc("degram.mapping.sessions")["result"]["sessions"]) == 3
        assert gh.commands() == []

    def test_session_answer_and_undo_return_the_panel_session(self, rt, dg):
        dg.routes[f"{BASE}/{SID}"] = (200, SESSION)
        dg.routes[f"POST {BASE}/{SID}/decisions"] = (200, {"decisions": [], "profiles": [], "session": SESSION})
        dg.routes[f"POST {BASE}/{SID}/undo"] = (200, SESSION)
        replies = [rpc("degram.mapping.session", {"sessionId": SID}),
                   rpc("degram.mapping.answer", {"sessionId": SID, "questionId": "Q-0000aaaa",
                                                 "optionId": "class:ex:GlassPanel", "groupIds": ["G-aaaa0001"]}),
                   rpc("degram.mapping.undo", {"sessionId": SID, "answerId": "A-1"})]
        for reply in replies:
            session = reply["result"]["session"]
            assert reply["result"]["status"] == "ok" and session["questions"][0]["items"] == [ITEM]
            assert session["llm"] == {"status": "pending"} and session["summary"] == SESSION["summary"]
            assert not {"elements", "groups", "parameters", "measures"} & set(session)
        assert dg.requests[1]["body"]["groupIds"] == ["G-aaaa0001"]
        assert dg.requests[2]["body"] == {"project": PROJECT, "answerId": "A-1"}

    def test_a_dg_refusal_is_a_json_rpc_error_with_the_server_code(self, rt, dg):
        dg.routes[f"POST {BASE}/{SID}/undo"] = (409, refusal("MAPPING_SESSION_APPLIED", "applied"))
        reply = rpc("degram.mapping.undo", {"sessionId": SID, "answerId": "A-1"})
        assert reply["error"]["code"] == 4409
        assert reply["error"]["data"] == {"code": "MAPPING_SESSION_APPLIED", "status": 409}
        assert "applied" in reply["error"]["message"]

    def test_dg_failures_are_outcomes(self, rt, dg):
        dg.routes[BASE] = (403, refusal("FORBIDDEN"))
        assert rpc("degram.mapping.sessions")["result"] == {
            "status": "error", "code": "ACCESS_DENIED", "message": "The DG backend refused the delegated token for "
            "this project.", "reason": "HTTP_403"}

    def test_start_sends_start_mapping_to_the_canvas(self, rt, gh):
        gh.handlers["start_mapping"] = {"started": True, "message": "Reading the canvas"}
        reply = rpc("degram.mapping.start")["result"]
        assert reply == {"status": "ok", "started": True, "message": "Reading the canvas"}
        assert gh.requests[-1] == {"type": "start_mapping", "parameters": {}}

    def test_focus_sends_the_component_id(self, rt, gh):
        gh.handlers["focus_component"] = lambda p: {"found": True, "componentId": p["componentId"], "name": "Panels A"}
        reply = rpc("degram.mapping.focus", {"componentId": COMPONENT})["result"]
        assert reply == {"status": "ok", "found": True, "componentId": COMPONENT, "name": "Panels A"}
        assert gh.requests[-1] == {"type": "focus_component", "parameters": {"componentId": COMPONENT}}

    @pytest.mark.parametrize("component", [None, "", "not-a-guid", "x" * 32])
    def test_focus_refuses_anything_but_an_instance_id_before_the_bridge(self, rt, gh, component):
        reply = rpc("degram.mapping.focus", {"componentId": component} if component is not None else {})
        assert reply["error"]["data"]["code"] == "BAD_REQUEST" and gh.commands() == []

    def test_canvas_outcomes_are_named(self, rt, gh, monkeypatch):
        gh.handlers["start_mapping"] = gh_error("BUSY")
        assert rpc("degram.mapping.start")["result"]["code"] == "BUSY"
        assert rpc("degram.mapping.focus", {"componentId": COMPONENT})["result"]["code"] == "EXTENSION_NOT_LOADED"
        monkeypatch.setattr(gh_bridge, "GH_PORT", free_port())
        assert rpc("degram.mapping.start")["result"]["bridgeState"] == "off"

    @pytest.mark.parametrize("method,params", [("degram.mapping.session", {}),
                                               ("degram.mapping.answer", {"sessionId": SID, "questionId": "Q"}),
                                               ("degram.mapping.undo", {"sessionId": SID}),
                                               ("degram.mapping.answer", {"sessionId": SID, "questionId": "Q",
                                                                          "optionId": "o", "groupIds": "G-1"}),
                                               ("degram.mapping.sessions", {"app": "autocad"})])
    def test_missing_or_mistyped_params_are_bad_requests_before_dg(self, rt, dg, method, params):
        assert rpc(method, params)["error"]["data"]["code"] == "BAD_REQUEST"
        assert dg.requests == []

    def test_all_mapping_rpcs_refuse_outside_variant_degram(self, rt, monkeypatch):
        monkeypatch.delenv("HERMES_DEGRAM")
        for method in ("degram.mapping.sessions", "degram.mapping.session", "degram.mapping.answer",
                       "degram.mapping.undo", "degram.mapping.start", "degram.mapping.focus"):
            assert rpc(method, {})["error"]["data"]["code"] == "NOT_DEGRAM", method

    def test_the_mapping_service_calls_the_revit_mcp_child_by_default(self, rt, dg):
        """Without an injected client the Revit side is the registered MCP tool path; no adapter connected reads as
        SETUP_INCOMPLETE for a start, and the session list still answers without the connector status."""
        assert isinstance(rt.mapping._revit, RevitBridgeClient)
        reply = rpc("degram.mapping.start", {"app": "revit"})["result"]
        assert (reply["status"], reply["code"], reply["reason"]) == ("error", "SETUP_INCOMPLETE",
                                                                    "REVIT_ADAPTER_NOT_CONNECTED")
        dg.routes[BASE] = (200, {"sessions": ROWS})
        listing = rpc("degram.mapping.sessions", {"document": "Tower Facade.rvt", "app": "revit"})["result"]
        assert [s["sessionId"] for s in listing["sessions"]] == ["ms-new", "ms-old"]
        assert not {"connector", "signedIn", "connectorSessionId", "connectorMessage"} & set(listing)


# -- Revit (1303-13; contract §8.5, D-47, D-51) ------------------------------------------------------------------

RSID = "ms-rvt000000001"
REVIT_ROWS = [
    {"sessionId": "ms-rvt-new", "label": "tower · 11:00:00", "document": "tower", "platform": "revit",
     "createdAt": "2026-10-18T11:00:00Z", "summary": {"total": 4}},
    {"sessionId": "ms-annex", "label": "annex · 10:30:00", "document": "annex", "platform": "revit",
     "createdAt": "2026-10-18T10:30:00Z", "summary": {"total": 1}},
    *ROWS,
    {"sessionId": "ms-rvt-old", "label": "tower · 07:00:00", "platform": "revit",  # older row: no document
     "createdAt": "2026-10-18T07:00:00Z", "summary": {"total": 2}},
]
STATUS = {"signedIn": True, "project": PROJECT, "document": "tower", "sessionId": "ms-rvt-new",
          "connectorMessage": "DG: 2 open questions", "elements": 4}
REVIT_SESSION = {
    **SESSION, "sessionId": RSID, "platform": "revit", "label": "tower · 11:00:00", "document": "tower",
    "elements": [
        {"nativeId": "uid-1", "groupId": "G-r1", "state": "ambiguous", "roles": []},
        {"nativeId": "uid-2", "groupId": "G-r1", "state": "ambiguous", "roles": []},
        {"nativeId": "uid-3", "groupId": "G-r2", "state": "confirmed", "roles": ["ex:GlassPanel"]},
        {"nativeId": "uid-1", "groupId": "G-r1", "state": "ambiguous", "roles": []},  # repeated row
        {"groupId": "G-r1", "state": "unmapped", "roles": []},  # no nativeId: nothing to show
        {"nativeId": "uid-9", "groupId": None, "state": "unmapped", "roles": []},  # in no group
    ],
}


class FakeRevit:
    """Stands in for ``RevitBridgeClient``: one handler per connector tool (a dict, a callable or a BridgeError);
    a tool without a handler is an adapter that is not connected."""

    def __init__(self) -> None:
        self.handlers: dict[str, Any] = {}
        self.calls: list[dict[str, Any]] = []

    def call(self, tool: str, arguments: dict[str, Any] | None = None, *, cancel=None,
             deadline_s: float | None = None) -> dict[str, Any]:
        self.calls.append({"tool": tool, "arguments": dict(arguments or {}), "deadline_s": deadline_s})
        handler = self.handlers.get(tool)
        if handler is None:
            raise BridgeError("SETUP_INCOMPLETE", "REVIT_ADAPTER_NOT_CONNECTED", "The Revit adapter is not connected.")
        if isinstance(handler, BridgeError):
            raise handler
        return handler(arguments or {}) if callable(handler) else handler

    def tools(self) -> list[str]:
        return [c["tool"] for c in self.calls]


@pytest.fixture
def revit(rt, monkeypatch):
    fake = FakeRevit()
    monkeypatch.setattr(rt.mapping, "_revit", fake)
    return fake


class TestRevitSessions:
    def test_rows_are_matched_by_the_rvt_document_key_and_carry_the_connector_status(self, rt, dg, gh, revit):
        dg.routes[BASE] = (200, {"sessions": REVIT_ROWS})
        revit.handlers["dg_mapping_status"] = STATUS
        reply = rpc("degram.mapping.sessions", {"document": "Tower.rvt", "app": "revit"})["result"]
        assert reply["status"] == "ok" and reply["document"] == "tower"
        assert [s["sessionId"] for s in reply["sessions"]] == ["ms-rvt-new", "ms-rvt-old"], "newest first, old by label"
        assert (reply["connector"], reply["signedIn"], reply["connectorSessionId"], reply["connectorMessage"]) == (
            True, True, "ms-rvt-new", "DG: 2 open questions")
        assert revit.calls == [{"tool": "dg_mapping_status", "arguments": {}, "deadline_s": REVIT_STATUS_DEADLINE_S}]
        assert gh.commands() == [], "a Revit document never asks the Grasshopper canvas"

    def test_a_connector_that_is_not_signed_in_says_so(self, rt, dg, revit):
        dg.routes[BASE] = (200, {"sessions": REVIT_ROWS})
        revit.handlers["dg_mapping_status"] = {"signedIn": False, "document": "tower", "sessionId": "",
                                               "connectorMessage": ""}
        reply = rpc("degram.mapping.sessions", {"document": "Tower.rvt", "app": "revit"})["result"]
        assert (reply["connector"], reply["signedIn"], reply["connectorSessionId"], reply["connectorMessage"]) == (
            True, False, None, None)

    @pytest.mark.parametrize("code", ["BUSY", "BRIDGE_OFF", "SETUP_INCOMPLETE", "EXTENSION_NOT_LOADED"])
    def test_a_failing_status_leaves_it_out_and_still_lists_the_sessions(self, rt, dg, revit, code):
        dg.routes[BASE] = (200, {"sessions": REVIT_ROWS})
        revit.handlers["dg_mapping_status"] = BridgeError(code, None, "no answer")
        reply = rpc("degram.mapping.sessions", {"document": "Tower.rvt", "app": "revit"})["result"]
        assert reply["status"] == "ok"
        assert [s["sessionId"] for s in reply["sessions"]] == ["ms-rvt-new", "ms-rvt-old"]
        assert not {"connector", "signedIn", "connectorSessionId", "connectorMessage"} & set(reply)

    def test_a_cancel_during_the_status_ends_the_request(self, rt, dg, revit):
        dg.routes[BASE] = (200, {"sessions": REVIT_ROWS})
        revit.handlers["dg_mapping_status"] = BridgeError("CANCELLED", "CANCELLED_BY_USER", "The read was cancelled.")
        assert rpc("degram.mapping.sessions", {"document": "Tower.rvt", "app": "revit"})["result"]["code"] == "CANCELLED"
        assert dg.requests == []

    def test_without_a_document_nothing_asks_the_connector(self, rt, dg, revit):
        dg.routes[BASE] = (200, {"sessions": REVIT_ROWS})
        assert len(rpc("degram.mapping.sessions", {"app": "revit"})["result"]["sessions"]) == len(REVIT_ROWS)
        assert revit.calls == []


class TestRevitStart:
    def test_start_calls_dg_start_mapping_and_names_the_new_session(self, rt, gh, revit):
        revit.handlers["dg_start_mapping"] = {"started": True, "sessionId": "ms-rvt-new",
                                              "message": "DG mapped 4 elements"}
        reply = rpc("degram.mapping.start", {"app": "revit"})["result"]
        assert reply == {"status": "ok", "started": True, "sessionId": "ms-rvt-new", "message": "DG mapped 4 elements"}
        assert revit.tools() == ["dg_start_mapping"] and revit.calls[0]["arguments"] == {}
        assert gh.commands() == [], "the canvas is not asked to start"

    def test_a_start_the_connector_declines_carries_its_message(self, rt, revit):
        revit.handlers["dg_start_mapping"] = {"started": False, "sessionId": None, "message": "DG: sign in first"}
        assert rpc("degram.mapping.start", {"app": "revit"})["result"] == {
            "status": "ok", "started": False, "sessionId": None, "message": "DG: sign in first"}

    def test_connector_outcomes_are_named(self, rt, revit):
        revit.handlers["dg_start_mapping"] = BridgeError("BUSY", "NO_RESPONSE", "Revit did not answer in time.")
        reply = rpc("degram.mapping.start", {"app": "revit"})["result"]
        assert (reply["status"], reply["code"], reply["bridgeState"]) == ("error", "BUSY", "busy")

    def test_grasshopper_stays_the_default_and_never_reaches_revit(self, rt, gh, revit):
        gh.handlers["start_mapping"] = {"started": True, "message": "Reading the canvas"}
        for params in ({}, {"app": "grasshopper"}):
            assert rpc("degram.mapping.start", params)["result"] == {
                "status": "ok", "started": True, "message": "Reading the canvas"}
        assert revit.calls == [] and gh.commands().count("start_mapping") == 2


class TestRevitFocus:
    def test_a_group_resolves_to_the_unique_ids_of_its_elements_from_the_full_session(self, rt, dg, revit):
        dg.routes[f"{BASE}/{RSID}"] = (200, REVIT_SESSION)
        revit.handlers["dg_show_elements"] = lambda a: {"found": len(a["unique_ids"]), "shown": len(a["unique_ids"]),
                                                        "missing": []}
        reply = rpc("degram.mapping.focus", {"app": "revit", "sessionId": RSID, "itemId": "G-r1"})["result"]
        assert reply == {"status": "ok", "found": True, "shown": 2, "missing": [], "itemId": "G-r1"}
        assert revit.calls[0]["tool"] == "dg_show_elements"
        assert revit.calls[0]["arguments"] == {"unique_ids": ["uid-1", "uid-2"]}, "group members, in order, no repeats"
        (req,) = dg.requests
        assert req["path"] == f"{BASE}/{RSID}?project={PROJECT}" and req["headers"]["Authorization"] == f"Bearer {TOKEN}"

    def test_elements_the_model_no_longer_holds_are_reported(self, rt, dg, revit):
        dg.routes[f"{BASE}/{RSID}"] = (200, REVIT_SESSION)
        revit.handlers["dg_show_elements"] = {"found": 1, "shown": 1, "missing": ["uid-2"]}
        reply = rpc("degram.mapping.focus", {"app": "revit", "sessionId": RSID, "itemId": "G-r1"})["result"]
        assert (reply["found"], reply["shown"], reply["missing"]) == (True, 1, ["uid-2"])
        revit.handlers["dg_show_elements"] = {"found": 0, "shown": 0, "missing": ["uid-1", "uid-2"]}
        reply = rpc("degram.mapping.focus", {"app": "revit", "sessionId": RSID, "itemId": "G-r1"})["result"]
        assert (reply["found"], reply["shown"], reply["missing"]) == (False, 0, ["uid-1", "uid-2"])

    def test_a_group_without_elements_is_not_found_and_revit_is_not_asked(self, rt, dg, revit):
        dg.routes[f"{BASE}/{RSID}"] = (200, REVIT_SESSION)
        reply = rpc("degram.mapping.focus", {"app": "revit", "sessionId": RSID, "itemId": "G-none"})["result"]
        assert reply == {"status": "ok", "found": False, "shown": 0, "missing": [], "itemId": "G-none"}
        assert revit.calls == []

    def test_a_group_larger_than_the_connector_limit_is_capped(self, rt, dg, revit):
        big = [{"nativeId": f"uid-{i:05d}", "groupId": "G-big"} for i in range(MAX_SHOW_ELEMENTS + 3)]
        dg.routes[f"{BASE}/{RSID}"] = (200, {**REVIT_SESSION, "elements": big})
        revit.handlers["dg_show_elements"] = {"found": MAX_SHOW_ELEMENTS, "shown": MAX_SHOW_ELEMENTS, "missing": []}
        rpc("degram.mapping.focus", {"app": "revit", "sessionId": RSID, "itemId": "G-big"})
        sent = revit.calls[0]["arguments"]["unique_ids"]
        assert sent == [e["nativeId"] for e in big[:MAX_SHOW_ELEMENTS]]

    def test_an_unknown_session_is_dg_s_refusal_and_revit_is_not_asked(self, rt, dg, revit):
        dg.routes[f"{BASE}/{RSID}"] = (404, refusal("MAPPING_SESSION_NOT_FOUND", "no such session"))
        reply = rpc("degram.mapping.focus", {"app": "revit", "sessionId": RSID, "itemId": "G-r1"})
        assert reply["error"]["code"] == 4404 and reply["error"]["data"]["code"] == "MAPPING_SESSION_NOT_FOUND"
        assert revit.calls == []

    def test_connector_outcomes_are_named(self, rt, dg, revit):
        dg.routes[f"{BASE}/{RSID}"] = (200, REVIT_SESSION)
        revit.handlers["dg_show_elements"] = BridgeError("BRIDGE_OFF", None, "Revit is not running.")
        reply = rpc("degram.mapping.focus", {"app": "revit", "sessionId": RSID, "itemId": "G-r1"})["result"]
        assert (reply["status"], reply["code"], reply["bridgeState"]) == ("error", "BRIDGE_OFF", "off")

    @pytest.mark.parametrize("params", [{"app": "revit"}, {"app": "revit", "sessionId": RSID},
                                        {"app": "revit", "itemId": "G-r1"}, {"app": "revit", "componentId": COMPONENT},
                                        {"app": "revit", "sessionId": "", "itemId": "G-r1"},
                                        {"app": "revit", "sessionId": RSID, "itemId": 7}])
    def test_revit_needs_a_session_and_an_item_before_dg_or_revit(self, rt, dg, revit, params):
        assert rpc("degram.mapping.focus", params)["error"]["data"]["code"] == "BAD_REQUEST"
        assert dg.requests == [] and revit.calls == []

    def test_grasshopper_focus_is_unchanged_and_never_reaches_revit(self, rt, gh, revit):
        gh.handlers["focus_component"] = lambda p: {"found": True, "name": "Panels A"}
        reply = rpc("degram.mapping.focus", {"app": "grasshopper", "componentId": COMPONENT})["result"]
        assert reply == {"status": "ok", "found": True, "componentId": COMPONENT, "name": "Panels A"}
        bad = rpc("degram.mapping.focus", {"app": "grasshopper", "sessionId": RSID, "itemId": "G-r1"})
        assert bad["error"]["data"]["code"] == "BAD_REQUEST", "grasshopper still needs a component id"
        assert revit.calls == []

    @pytest.mark.parametrize("method", ["degram.mapping.start", "degram.mapping.focus"])
    def test_an_unknown_application_is_a_bad_request(self, rt, gh, revit, method):
        assert rpc(method, {"app": "autocad"})["error"]["data"]["code"] == "BAD_REQUEST"
        assert revit.calls == [] and gh.commands() == []
