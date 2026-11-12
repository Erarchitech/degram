"""Advanced Revit mapping, client side (DG plan 1303-35 Task 1; D-45, D-134..D-137, Q1, Q2, Q5, R10, R11).

Production path first: the six new RPC names go through the real gateway dispatcher (``server.handle_request``),
the environment admission and the generated contracts; the service sits behind them with a fake DG backend on
loopback HTTP and either a fake Revit client or the fake MCP child of ``fixtures/fake_revit_mcp.py`` (the real
registry and the real MCP handler). No Revit, no DG stack, no model provider.

What these tests pin down:

* exactly six names are admitted, none by wildcard, and a request with a proof flag (``confirmed``, ``byAgent``,
  ``actor``) or a foreign ``project`` never reaches a handler;
* the ordinary answer refuses every spelling of a protected ``advanced:`` question, called as RPC or directly;
* a native-only tool is neither registered (so the agent never sees it) nor reachable through ``call``; the broker
  reaches it only through ``call_native``, once, and a timeout reports an unresolved outcome instead of repeating it;
* an advanced answer or commit is posted only with a proof the server confirms for exactly that action and scope;
* a reply that arrives after the credential or the pinned model changed (A -> B -> A) is discarded.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

import tui_gateway.server as server
from degram_variant import lockdown, revit_bridge
from degram_variant.credentials import credentials
from degram_variant.dg_client import DgClient, DgRefused
from degram_variant.outcomes import BridgeError

from .conftest import PROJECT, TOKEN
from .test_mapping import BASE, REVIT_SESSION, RSID, FakeRevit, refusal, rpc

SIX = ("degram.mapping.advanced.answer", "degram.mapping.advanced.answers", "degram.mapping.advanced.derive", "degram.mapping.advanced.preview",
       "degram.mapping.advanced.clearPreview", "degram.mapping.advanced.mode", "degram.mapping.advanced.confirmIntent")
DEF = "MD-0123456789ab"
INTENT = "hi-0123456789abcdef01234567"
REQ = "derive-req-0001"
RESULT_HASH = "b" * 64
MANIFEST_HASH = "c" * 64
GUID = "aaaaaaaa-0000-0000-0000-000000000001"
IDENTITY = {"creationGuid": GUID, "pathName": "C:\\work\\tower.rvt"}
CAPABILITIES = ["instances", "owned-delete", "exact-receipts", "document-validation", "native-intent", "recovery"]
ENV_ID = "dg-env-v1-" + "a" * 64
FAKE_SERVER = Path(__file__).parent / "fixtures" / "fake_revit_mcp.py"

APPROVE_SCOPE = {"definitionId": DEF, "definitionVersion": 2, "resultHash": RESULT_HASH, "bindingRevision": 4}
SKIP_SCOPE = {"definitionId": DEF, "definitionVersion": 2, "resultHash": RESULT_HASH}
PREVIEW_SCOPE = {"definitionId": DEF, "definitionVersion": 2, "resultHash": RESULT_HASH}
COMMIT_SCOPE = {"batchManifestHash": MANIFEST_HASH}
VALID_PARAMS = {
    "degram.mapping.advanced.answer": {"sessionId": RSID, "requestId": "r-answer-1", "intentId": INTENT,
                                       "action": "approve", "scope": APPROVE_SCOPE},
    "degram.mapping.advanced.answers": {"sessionId": RSID, "requestId": "bulk-001", "intentId": INTENT,
        "scope": {"items": [{"definitionId": f"MD-{n:012x}", "definitionVersion": 2, "definitionRevision": 1,
                            "modeRevision": 0, "bindingRevision": 4, "resultHash": RESULT_HASH} for n in (1, 2)]}},
    "degram.mapping.advanced.derive": {"sessionId": RSID, "definitionId": DEF, "requestId": REQ},
    "degram.mapping.advanced.preview": {"sessionId": RSID, "intentId": INTENT},
    "degram.mapping.advanced.clearPreview": {"sessionId": RSID, "intentId": INTENT},
    "degram.mapping.advanced.mode": {"definitionId": DEF, "mode": "ordinary", "expectedRevision": 3},
    "degram.mapping.advanced.confirmIntent": {"sessionId": RSID, "intentId": INTENT, "scope": APPROVE_SCOPE},
}


# -- doubles ------------------------------------------------------------------------------------------------------


class AdvRevit(FakeRevit):
    """``FakeRevit`` plus the broker's ``call_native`` (recorded separately, so a test sees which door was used)."""

    def __init__(self) -> None:
        super().__init__()
        self.native: list[dict[str, Any]] = []

    def call_native(self, tool: str, arguments: dict[str, Any] | None = None, *, cancel=None,
                    deadline_s: float | None = None) -> dict[str, Any]:
        self.native.append({"tool": tool, "arguments": dict(arguments or {})})
        handler = self.handlers.get(tool)
        if handler is None:
            raise BridgeError("SETUP_INCOMPLETE", "REVIT_ADAPTER_NOT_CONNECTED", "The Revit adapter is not connected.")
        if isinstance(handler, BridgeError):
            raise handler
        return handler(arguments or {}) if callable(handler) else handler


class _Source:
    """The Revit document source of the picker, so a test can pin without a Revit child."""

    app = "revit"

    def list_documents(self, cancel=None):
        return [{"app": "revit", "name": "tower.rvt", "path": IDENTITY["pathName"], "unsaved": False,
                 "identity": dict(IDENTITY), "isModified": False, "isActive": True}]

    def read_snapshot(self, *args, **kwargs):  # pragma: no cover - never read here
        raise NotImplementedError


def _open_documents(active: bool = True, guid: str = GUID) -> dict:
    return {"status": "ok", "documents": [{"title": "tower.rvt", "pathName": IDENTITY["pathName"],
                                           "creationGuid": guid, "isActive": active, "isModified": False}]}


@pytest.fixture
def revit(rt, monkeypatch):
    fake = AdvRevit()
    fake.handlers["list_open_documents"] = _open_documents()
    monkeypatch.setattr(rt.mapping, "_revit", fake)
    return fake


@pytest.fixture
def degram_env(monkeypatch):
    """Variant degram on, nothing else: for the tests that need no server (the lockdown tables, the doors)."""
    monkeypatch.setenv("HERMES_DEGRAM", "1")


@pytest.fixture
def lite(monkeypatch):
    """A runtime in variant degram with the delegated credential and NO servers: any HTTP request the code under test
    tried to send fails the test (so "nothing was sent" is asserted by construction, without a fake backend)."""
    from degram_variant import runtime

    monkeypatch.setenv("HERMES_DEGRAM", "1")
    credentials.clear()
    credentials.set(token=TOKEN, expires_at=time.time() + 600, relay_base_url="http://127.0.0.1:9/data-service",
                    user="alice", company="acme", project=PROJECT)

    def no_http(*args, **kwargs):
        raise AssertionError("an HTTP request was sent")

    monkeypatch.setattr(DgClient, "_send", no_http)
    runtime.reset()
    current = runtime.get()
    current.mapping._revit = AdvRevit()
    yield current
    runtime.reset()
    credentials.clear()


@pytest.fixture
def pinned(rt):
    rt.documents._sources["revit"] = _Source()
    rt.documents.pin("revit", dict(IDENTITY))
    return rt.documents


def _definition(**over) -> dict:
    base = {"definitionId": DEF, "classIri": "ex:Building", "revision": 3, "mode": "advanced", "modeRevision": 1,
            "head": {"version": 2, "kind": "derived", "status": "draft", "source": "agent", "proposedBy": "alice"},
            "effective": {"version": 1, "kind": "derived", "status": "approved", "source": "member",
                          "proposedBy": "alice"},
            "modeProposal": None, "versions": [1, 2]}
    base.update(over)
    return base


def _binding(**over) -> dict:
    base = {"bindingId": "MB-0123456789ab", "definitionId": DEF, "document": "tower", "revision": 4,
            "resultStatus": "ok", "resultHash": RESULT_HASH, "resultDefinitionVersion": 2, "change": "changed",
            "pendingDerive": None, "approved": {"definitionVersion": 1, "resultHash": "e" * 64, "memberCount": 9,
                                                 "approvedAt": "2026-11-10T10:00:00Z"},
            "skipped": None, "materialization": {"state": "queued", "ownedCount": 0}, "eligibility": {"ok": True}}
    base.update(over)
    return base


def _revit_session(**over) -> dict:
    session = {**REVIT_SESSION, "revision": "a" * 24, "advanced": {
        "definitions": [_definition()], "bindings": [_binding()],
        "pending": [{"answerId": "A-adv1", "definitionId": DEF, "action": "approve", "definitionVersion": 2,
                     "bindingRevision": 4, "resultHash": RESULT_HASH, "intentId": INTENT, "valid": True,
                     "invalidReasons": []}],
        "candidates": [], "revision": "r" * 24,
        "commit": {"batchManifestHash": MANIFEST_HASH, "upserts": 1, "deletes": 0, "direct": 0, "ordinary": 0,
                   "required": CAPABILITIES}},
        "connector": {"createdByConnector": True, "target": {
            "version": 1, "supported": True, "capabilities": list(CAPABILITIES), "runtimeId": "rt-1",
            "modelKey": "tower-key", "generation": 3}},
        "batches": [{"batchId": "commit-1", "delivery": {"state": "queued"}}]}
    session.update(over)
    return session


def _intent(action: str, scope: dict, status: str = "confirmed", **over) -> dict:
    base = {"intentId": INTENT, "requestId": "r-1", "project": PROJECT, "sessionId": RSID, "action": action,
            "document": "tower", "sessionRevision": "a" * 24, "scope": dict(scope), "scopeHash": "d" * 64,
            "issuedBy": "alice", "issuedAt": "2026-11-10T10:00:00Z", "expiresAt": "2026-11-10T10:10:00Z",
            "status": status}
    base.update(over)
    return base


def _routes(dg, session=None, intent=None) -> None:
    dg.routes[f"{BASE}/{RSID}"] = (200, session if session is not None else _revit_session())
    if intent is not None:
        dg.routes[f"{BASE}/{RSID}/human-intents/{INTENT}"] = (200, intent)


def _writes(dg) -> list[str]:
    return [f"{r['method']} {r['path'].split('?', 1)[0]}" for r in dg.requests if r["method"] == "POST"]


# -- 1. admission: the real dispatcher, the environment barrier and the contracts ---------------------------------


class TestAdmission:
    def test_exactly_six_advanced_names_are_admitted(self, degram_env):
        advanced = {n for n in lockdown.ALLOWED_RPC_METHODS if n.startswith("degram.mapping.advanced")}
        assert advanced == set(SIX)
        for name in SIX:
            lockdown.assert_rpc_allowed(name, {})  # does not raise

    @pytest.mark.parametrize("name", [
        "degram.mapping.advanced", "degram.mapping.advanced.*", "degram.mapping.advanced.approve",
        "degram.mapping.advanced.skip", "degram.mapping.advanced.apply", "degram.mapping.advanced.commit",
        "degram.mapping.advanced.Answer", "degram.mapping.advanced.answer ", "degram.mapping.advanced.propose",
        "degram.mapping.advanced.answer.extra", "degram.mapping.advancedanswer", "degram.mapping.*"])
    def test_no_wildcard_and_no_sibling_name_is_admitted(self, degram_env, name):
        with pytest.raises(lockdown.DegramLockedError):
            lockdown.assert_rpc_allowed(name, {})
        response = rpc(name, {})
        assert response["error"]["data"]["code"] == "DEGRAM_LOCKED"

    def test_stock_rpc_families_stay_closed(self, degram_env):
        for name in ("tools.call", "session.cwd.set", "shell.exec", "mcp.servers.add", "mcp.call_tool",
                     "degram.mapping.dispatch", "degram.revit.call", "degram.tool.call"):
            assert rpc(name, {})["error"]["data"]["code"] == "DEGRAM_LOCKED", name

    def test_every_name_has_a_handler_and_a_contract(self, degram_env):
        from tui_gateway.contracts import registry

        for name in SIX:
            assert name in server._methods, name
            assert name in registry.METHODS, name
            assert name in server._LONG_HANDLERS, f"{name} may wait for Revit and must not block the RPC reader"

    @pytest.mark.parametrize("name", SIX)
    def test_valid_params_pass_the_contract(self, rt, dg, revit, name):
        response = rpc(name, VALID_PARAMS[name])
        assert response.get("error", {}).get("code") != 4000, response
        assert response.get("error", {}).get("data", {}).get("code") != "DEGRAM_LOCKED", response

    @pytest.mark.parametrize("name", SIX)
    @pytest.mark.parametrize("extra", [{"confirmed": True}, {"byAgent": False}, {"actor": "alice"},
                                       {"project": "foreign"}, {"tool": "execute_revit_code"}])
    def test_a_proof_flag_or_a_foreign_project_never_reaches_a_handler(self, lite, name, extra):
        response = rpc(name, {**VALID_PARAMS[name], **extra})
        assert response["error"]["code"] == 4000, response
        assert lite.mapping._revit.calls == [] and lite.mapping._revit.native == []

    @pytest.mark.parametrize("name", SIX)
    def test_a_quiesced_backend_refuses_every_name_without_a_call(self, lite, name):
        quiesce = rpc("degram.environment.quiesce", {"environmentId": ENV_ID, "generation": 1})
        assert quiesce["result"]["ok"] is True
        try:
            response = rpc(name, VALID_PARAMS[name])
        finally:
            rpc("degram.environment.resume", {"environmentId": ENV_ID, "generation": 1})
        assert response["error"]["data"]["code"] == "ENVIRONMENT_QUIESCED"
        assert lite.mapping._revit.calls == [] and lite.mapping._revit.native == []

    @pytest.mark.parametrize("name", SIX)
    def test_every_name_refuses_outside_variant_degram(self, lite, monkeypatch, name):
        monkeypatch.delenv("HERMES_DEGRAM")
        response = rpc(name, VALID_PARAMS[name])
        assert response["error"]["data"]["code"] in ("NOT_DEGRAM", "DEGRAM_LOCKED"), response

    def test_a_late_reply_of_an_earlier_scope_is_discarded_and_the_switch_waits_for_it(self, rt, dg, revit, pinned):
        """A -> B -> A while a protected answer is in flight: the backend is busy (no quiesce), and when the old reply
        arrives after the credential went to B and back to A, it is dropped, not shown as the answer of A."""
        _routes(dg, intent=_intent("advanced-approve", APPROVE_SCOPE))
        entered, gate, out = threading.Event(), threading.Event(), []

        def slow(request):
            entered.set()
            gate.wait(10)
            return 200, _revit_session()

        dg.routes[f"POST {BASE}/{RSID}/advanced/answer"] = slow
        params = {"sessionId": RSID, "requestId": "r-answer-1", "intentId": INTENT, "action": "approve",
                  "scope": APPROVE_SCOPE}
        worker = threading.Thread(target=lambda: out.append(rpc("degram.mapping.advanced.answer", params)))
        worker.start()
        try:
            assert entered.wait(10)
            busy = rpc("degram.environment.quiesce", {"environmentId": ENV_ID, "generation": 1})
            assert busy["error"]["data"]["code"] == "ENVIRONMENT_BUSY"
            info = credentials.info()
            credentials.set(token="dgd_other_environment_token", expires_at=time.time() + 600,
                            relay_base_url=info.relay_base_url, user="bob", company="acme", project="annex")
            credentials.set(token=TOKEN, expires_at=time.time() + 600, relay_base_url=info.relay_base_url,
                            user="alice", company="acme", project=PROJECT)
        finally:
            gate.set()
            worker.join(10)
        result = out[0]["result"]
        assert (result["status"], result["code"], result["reason"]) == ("error", "CANCELLED", "SCOPE_CHANGED")
        assert not result.get("session")

    def test_revoking_the_credential_during_a_call_discards_its_reply(self, rt, dg, revit, pinned):
        _routes(dg, intent=_intent("advanced-approve", APPROVE_SCOPE))
        entered, gate, out = threading.Event(), threading.Event(), []

        def slow(request):
            entered.set()
            gate.wait(10)
            return 200, _revit_session()

        dg.routes[f"POST {BASE}/{RSID}/advanced/answer"] = slow
        params = {"sessionId": RSID, "requestId": "r-answer-2", "intentId": INTENT, "action": "approve",
                  "scope": APPROVE_SCOPE}
        worker = threading.Thread(target=lambda: out.append(rpc("degram.mapping.advanced.answer", params)))
        worker.start()
        try:
            assert entered.wait(10)
            assert rpc("degram.credentials.clear", {})["result"]["ok"] is True
        finally:
            gate.set()
            worker.join(10)
        result = out[0]["result"]
        assert (result["status"], result["code"]) == ("error", "CANCELLED") and not result.get("session")
        assert rpc("degram.mapping.advanced.answer", params)["result"]["code"] == "CREDENTIALS_MISSING"


# -- 2. the ordinary answer never answers a protected question ---------------------------------------------------

PROTECTED_SPELLINGS = [
    f"advanced:{DEF}", f" advanced:{DEF}", f"ADVANCED:{DEF}", f"Advanced:{DEF}", f"advanced\uff1a{DEF}",
    f"adv\u200banced:{DEF}", f"advanced%3A{DEF}", f"\u2060advanced:{DEF}", "advanced:", "advanced:anything",
    f"\tadvanced:{DEF}\n", f"advanced:{DEF}\x00"]


class TestOrdinaryAnswerRefusesProtectedQuestions:
    @pytest.mark.parametrize("question", PROTECTED_SPELLINGS)
    def test_the_rpc_refuses_every_spelling_before_dg(self, lite, question):
        reply = rpc("degram.mapping.answer", {"sessionId": RSID, "questionId": question, "optionId": "approve"})
        assert reply["error"]["data"]["code"] == "MAPPING_PROTECTED_QUESTION", reply

    @pytest.mark.parametrize("question", PROTECTED_SPELLINGS)
    def test_a_direct_service_call_refuses_it_too(self, lite, question):
        for by_agent in (False, True):
            with pytest.raises(DgRefused) as exc:
                lite.mapping.answer(RSID, question, "approve", by_agent=by_agent)
            assert exc.value.code == "MAPPING_PROTECTED_QUESTION" and exc.value.status == 409

    def test_a_direct_client_call_refuses_it_too(self, lite):
        with pytest.raises(DgRefused) as exc:
            DgClient().post_mapping_decision(RSID, f"advanced:{DEF}", "approve")
        assert exc.value.code == "MAPPING_PROTECTED_QUESTION"

    def test_an_ordinary_question_still_goes_through(self, rt, dg):
        dg.routes[f"POST {BASE}/{RSID}/decisions"] = (200, {"decisions": [], "profiles": [], "session": {
            "sessionId": RSID, "answers": []}})
        reply = rpc("degram.mapping.answer", {"sessionId": RSID, "questionId": "Q-0000aaaa", "optionId": "class:ex:A"})
        assert reply["result"]["status"] == "ok" and len(dg.requests) == 1

    def test_a_mixed_commit_without_a_remembered_proof_is_refused_before_dg(self, rt, dg):
        """The panel read told the service which answers are protected; an apply that names one without the proof
        of the common commit is refused locally, nothing is posted."""
        dg.routes[f"{BASE}/{RSID}"] = (200, _revit_session())
        assert rpc("degram.mapping.session", {"sessionId": RSID})["result"]["status"] == "ok"
        dg.requests.clear()
        reply = rpc("degram.mapping.apply", {"sessionId": RSID, "requestId": "commit-1", "revision": "a" * 24,
                                             "answerIds": ["A-adv1", "A-ord1"]})
        assert reply["error"]["data"]["code"] == "INTENT_REQUIRED"
        assert dg.requests == []


# -- 3. classified Revit admission, native-only tools, the registry and the bridge --------------------------------

ALL_TOOLS = {
    "read": ("get_revit_status", "get_revit_model_info", "list_open_documents", "get_selection_snapshot",
             "get_element_properties", "list_levels", "get_current_view_info", "list_category_parameters",
             "get_revit_view", "list_revit_views", "get_current_view_elements", "get_selected_elements",
             "list_families", "list_family_categories", "analyze_model_statistics", "ai_element_filter",
             "check_clashes", "export_room_data", "get_material_quantities", "dg_mapping_status",
             "dg_list_mapping_categories", "dg_list_mapping_views", "dg_model_overview", "dg_read_selection",
             "dg_derive_definition"),
    "element-mutator": ("set_parameter", "modify_element", "transform_elements", "delete_elements", "dg_restate"),
    "bulk-mutator": ("color_splash", "clear_colors"),
    "creator": ("create_line_based_element", "create_surface_based_element", "place_family", "create_detail_line",
                "create_dimensions", "create_grid", "create_level", "create_duct", "create_pipe", "create_mep_system",
                "create_room", "create_room_separation", "create_schedule", "create_sheet",
                "create_structural_framing", "create_view", "tag_elements", "tag_walls", "link_file", "load_family"),
    "code": ("execute_revit_code",),
    "dg": ("dg_start_mapping", "dg_show_elements", "dg_clear_mapping_colours"),
    "view": ("set_active_view",),
    "export": ("save_document", "export_document", "export_ifc"),
}
NATIVE_ONLY = ("dg_confirm_mapping_intent", "dg_preview_definition", "dg_clear_definition_preview")


class TestClassifiedRevitAdmission:
    @pytest.mark.parametrize("tool,cls", [(t, c) for c, names in ALL_TOOLS.items() for t in names])
    def test_every_supported_tool_is_admitted_with_its_class(self, degram_env, tool, cls):
        name = f"{lockdown.REVIT_TOOL_PREFIX}{tool}"
        assert lockdown.revit_tool_class(name) == cls
        assert lockdown.revit_tool_allowed(name) is True
        assert lockdown.tool_name_allowed(name) is True

    @pytest.mark.parametrize("tool", NATIVE_ONLY)
    def test_a_native_only_tool_is_not_an_agent_tool(self, degram_env, tool):
        name = f"{lockdown.REVIT_TOOL_PREFIX}{tool}"
        assert lockdown.revit_tool_class(name) == "human-native"
        assert lockdown.revit_tool_allowed(name) is False, "the registry gate must not register it"
        assert lockdown.tool_name_allowed(name) is False
        assert lockdown.revit_native_tool_allowed(name) is True

    @pytest.mark.parametrize("name", [
        "mcp__revit__a_tool_the_fork_adds_tomorrow", "mcp__revit__x", "mcp__revit__", "mcp__revit__DG_PREVIEW_DEFINITION",
        "mcp__revit__ dg_model_overview", "mcp__revit__dg_model_overview ", "mcp__revit__set_parameter2",
        "mcp__revits__set_parameter", "mcp__other__set_parameter", "mcp_revit_set_parameter", "set_parameter", ""])
    def test_an_unclassified_or_foreign_name_fails_closed(self, degram_env, name):
        assert lockdown.revit_tool_class(name) is None
        assert lockdown.revit_tool_allowed(name) is False
        assert lockdown.revit_native_tool_allowed(name) is False
        assert lockdown.tool_name_allowed(name) is False

    def test_the_classification_covers_exactly_the_tools_of_the_connector_when_it_is_present(self):
        """Drift guard: a tool the connector adds must be classified here before it is admitted. Skipped when the
        framework's connector sources are not next to the component."""
        import re

        root = Path(__file__).resolve().parents[4] / "apps" / "dg-revit-connector" / "tools"
        if not root.is_dir():
            pytest.skip("the connector sources are not beside this checkout")
        names: set[str] = set()
        for path in root.glob("*.py"):
            names.update(re.findall(r"^    (?:async )?def ([a-z_][a-z0-9_]*)\(", path.read_text(encoding="utf-8"),
                                    re.M))
        names -= {"wrapper", "register_dg_connector_tools"}
        classified = {n.removeprefix(lockdown.REVIT_TOOL_PREFIX) for n in lockdown.REVIT_TOOL_CLASSES}
        assert names - classified == set(), f"unclassified connector tools: {sorted(names - classified)}"

    def test_the_registry_gate_registers_the_classified_tools_and_refuses_the_rest(self, degram_env):
        from tools.registry import ToolRegistry

        reg = ToolRegistry()
        schema = {"name": "x", "description": "d", "parameters": {"type": "object", "properties": {}}}
        for tool in ("dg_model_overview", "modify_element", "execute_revit_code", *NATIVE_ONLY,
                     "a_tool_the_fork_adds_tomorrow"):
            reg.register(name=f"mcp__revit__{tool}", toolset="mcp-revit", schema=schema, handler=lambda a, **k: "{}")
        assert sorted(reg.get_all_tool_names()) == ["mcp__revit__dg_model_overview", "mcp__revit__execute_revit_code",
                                                    "mcp__revit__modify_element"]

    def test_the_native_guard_is_the_authority_for_what_an_admitted_tool_may_do(self):
        """The Python table only decides what is registered; it says so, so nobody reads it as the guard."""
        assert "authoritative" in (lockdown.revit_tool_class.__doc__ or "").lower()


class TestBridgeDoors:
    def test_call_refuses_a_native_only_tool_and_an_unknown_one_before_the_registry(self, degram_env, monkeypatch):
        from tools.registry import registry

        def boom(*args, **kwargs):  # pragma: no cover - must not be reached
            raise AssertionError("the registry was asked")

        monkeypatch.setattr(registry, "get_entry", boom)
        client = revit_bridge.RevitBridgeClient()
        for tool in (*NATIVE_ONLY, "a_tool_the_fork_adds_tomorrow", "", "mcp__revit__set_parameter"):
            with pytest.raises(BridgeError) as exc:
                client.call(tool, {})
            assert (exc.value.code, exc.value.reason) == ("DEGRAM_LOCKED", "REVIT_TOOL_NOT_ALLOWED"), tool

    def test_call_native_takes_only_the_three_native_tools(self, degram_env, monkeypatch):
        monkeypatch.setattr(revit_bridge, "_native_handler", lambda tool: pytest.fail("a handler was built"))
        client = revit_bridge.RevitBridgeClient()
        for tool in ("modify_element", "execute_revit_code", "dg_model_overview", "dg_derive_definition", "",
                     "a_tool_the_fork_adds_tomorrow"):
            with pytest.raises(BridgeError) as exc:
                client.call_native(tool, {"intent_id": INTENT})
            assert (exc.value.code, exc.value.reason) == ("DEGRAM_LOCKED", "REVIT_TOOL_NOT_ALLOWED"), tool

    def test_a_native_call_times_out_as_unresolved_and_is_not_repeated(self, degram_env, monkeypatch):
        calls = []

        def hang(args, **kwargs):
            calls.append(dict(args))
            time.sleep(1.5)
            return json.dumps({"result": json.dumps({"status": "ok", "outcome": "completed"})})

        monkeypatch.setattr(revit_bridge, "_native_handler", lambda tool: hang)
        client = revit_bridge.RevitBridgeClient()
        with pytest.raises(BridgeError) as exc:
            client.call_native("dg_preview_definition", {"intent_id": INTENT}, deadline_s=0.2)
        assert exc.value.code == "BUSY" and exc.value.reason == "NATIVE_OUTCOME_UNRESOLVED"
        assert exc.value.to_dict()["unresolved"] is True
        assert len(calls) == 1, "no automatic retry of a native action"

    def test_a_native_call_cancelled_midway_is_unresolved_too(self, degram_env, monkeypatch):
        from degram_variant.cancel import CancelToken

        cancel = CancelToken()
        started = threading.Event()

        def slow(args, **kwargs):
            started.set()
            time.sleep(1.5)
            return json.dumps({"result": json.dumps({"status": "ok"})})

        monkeypatch.setattr(revit_bridge, "_native_handler", lambda tool: slow)
        threading.Timer(0.2, cancel.cancel).start()
        with pytest.raises(BridgeError) as exc:
            revit_bridge.RevitBridgeClient().call_native("dg_clear_definition_preview", {"intent_id": INTENT},
                                                         cancel=cancel, deadline_s=5)
        assert exc.value.to_dict().get("unresolved") is True and exc.value.reason == "NATIVE_OUTCOME_UNRESOLVED"


@pytest.fixture
def adapter(rt, tmp_path, monkeypatch):
    """The fake connector as MCP server ``revit`` with no include list: the real registry decides what registers."""
    from tools import mcp_tool
    from tools.mcp_tool_discovery import register_mcp_servers
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers

    mode_file, calls_file = tmp_path / "mode.json", tmp_path / "calls.jsonl"
    mode_file.write_text(json.dumps({"mode": "ok"}), encoding="utf-8")
    calls_file.write_text("", encoding="utf-8")
    config = {"revit": {
        "command": sys.executable, "args": [str(FAKE_SERVER)], "enabled": True, "connect_timeout": 20, "timeout": 40,
        "env": {"DEGRAM_MODE": "1", "FAKE_REVIT_MODE_FILE": str(mode_file), "FAKE_REVIT_CALLS_FILE": str(calls_file)},
        "tools": {"resources": False, "prompts": False}}}
    names = register_mcp_servers(config)

    class Adapter:
        registered = names

        def mode(self, **kw):
            mode_file.write_text(json.dumps(kw), encoding="utf-8")

        def calls(self):
            return [json.loads(line) for line in calls_file.read_text(encoding="utf-8").splitlines() if line.strip()]

    yield Adapter()
    shutdown_mcp_servers()
    with mcp_tool._lock:
        mcp_tool._servers.clear()
        mcp_tool._server_connecting.clear()
        mcp_tool._server_connect_errors.clear()


class TestRealRegistryAndHandler:
    def test_the_agent_registry_holds_the_reads_and_not_the_native_only_tools(self, rt, adapter):
        from tools.registry import registry

        names = set(registry.get_all_tool_names())
        assert "mcp__revit__dg_model_overview" in names and "mcp__revit__dg_derive_definition" in names
        for tool in (*NATIVE_ONLY, "a_tool_the_fork_adds_tomorrow"):
            assert f"mcp__revit__{tool}" not in names, tool
            assert registry.get_entry(f"mcp__revit__{tool}") is None
            assert "Unknown tool" in str(registry.dispatch(f"mcp__revit__{tool}", {"intent_id": INTENT}))
        assert not [c for c in adapter.calls() if c["tool"] in (*NATIVE_ONLY, "a_tool_the_fork_adds_tomorrow")]

    def test_the_broker_door_reaches_the_native_tool_exactly_once(self, rt, adapter):
        reply = revit_bridge.RevitBridgeClient().call_native("dg_confirm_mapping_intent", {"intent_id": INTENT})
        assert reply["decision"] == "confirmed" and reply["intent"]["intentId"] == INTENT
        assert adapter.calls() == [{"tool": "dg_confirm_mapping_intent", "arguments": {"intent_id": INTENT},
                                    "pid": adapter.calls()[0]["pid"]}]

    def test_the_agent_door_still_reads_through_the_registered_handler(self, rt, adapter):
        reply = revit_bridge.RevitBridgeClient().call("dg_read_selection", {})
        assert reply["uniqueIds"] == ["uid-1"]

    def test_a_native_refusal_is_a_named_outcome_not_a_success(self, rt, adapter):
        adapter.mode(mode="error", code="BRIDGE_OFF")
        with pytest.raises(BridgeError) as exc:
            revit_bridge.RevitBridgeClient().call_native("dg_preview_definition", {"intent_id": INTENT})
        assert exc.value.code == "BRIDGE_OFF"
        assert len(adapter.calls()) == 1


# -- 4. the service: definitions, proposals, modes, derive ---------------------------------------------------------


class TestDefinitionsAndProposals:
    @pytest.mark.parametrize("action,tool", [("overview", "dg_model_overview"), ("selection", "dg_read_selection")])
    def test_agent_reads_pinned_model_through_registry(self, rt, dg, revit, pinned, action, tool):
        import tools.degram_tools
        from tools.registry import registry

        revit.handlers[tool] = {"status": "ok", "gridLabels": ["A", "1"], "ids": ["pinned-member"]}
        raw = registry.dispatch("degram_mapping", {"action": action})
        out = json.loads(raw) if isinstance(raw, str) else raw
        assert out["status"] == "ok" and out["gridLabels"] == ["A", "1"]
        assert out["model"]["name"] == "tower.rvt"
        assert [c["tool"] for c in revit.calls] == ["list_open_documents", tool, "list_open_documents"]
        assert dg.requests == [] and revit.native == []

    @pytest.mark.parametrize("operation", ["definitions", "propose", "mode", "state", "session"])
    @pytest.mark.parametrize("change", ["credentials", "pin"])
    def test_changed_generation_discards_advanced_reply(self, rt, pinned, monkeypatch, operation, change):
        def delayed(*args, **kwargs):
            if change == "credentials":
                credentials.clear()
            else:
                pinned.unpin("revit")
            return {"definitions": [_definition()], "definition": _definition(), **_revit_session()}

        method = {"definitions": "get_definitions", "propose": "propose_definition",
                  "mode": "propose_mode", "state": "get_mapping_session", "session": "get_mapping_session"}[operation]
        monkeypatch.setattr(rt.mapping._dg, method, delayed)
        with pytest.raises(BridgeError) as exc:
            if operation == "definitions":
                rt.mapping.definitions()
            elif operation == "propose":
                rt.mapping.propose("ex:Building", "derived", {"recipe": "building-envelope", "version": 1})
            elif operation == "mode":
                rt.mapping.propose_mode(DEF, "ordinary", 3)
            elif operation == "session":
                rt.mapping.session(RSID)
            else:
                rt.mapping.advanced_state(RSID)
        assert exc.value.code == "CANCELLED" and exc.value.reason == "SCOPE_CHANGED"
        assert rt.mapping._advanced_pending == {}, "stale replies must not update the current scope's pending cache"

    def test_definitions_are_read_and_the_agent_proposals_are_marked(self, rt, dg):
        dg.routes["/data-service/mapping/definitions"] = (200, {
            "definitions": [_definition(),
                            _definition(definitionId="MD-ffffffffffff", classIri="ex:Room",
                                        head={"version": 1, "status": "draft", "source": "member"},
                                        effective=None, modeProposal={"mode": "ordinary", "source": "agent"})],
            "bindings": [_binding()]})
        out = rt.mapping.definitions()
        assert dg.requests[0]["path"].startswith("/data-service/mapping/definitions?project=tower")
        assert out["agentDefinitionClasses"] == ["ex:Building"]
        assert out["agentModeProposalClasses"] == ["ex:Room"]
        assert out["definitions"][0]["effective"]["version"] == 1, "the approved version stays visible next to the draft"

    def test_a_proposal_posts_a_cas_draft_and_calls_nothing_in_revit(self, rt, dg, revit):
        draft = _definition(revision=4, head={"version": 3, "status": "draft", "source": "agent"})
        dg.routes["POST /data-service/mapping/definitions"] = (200, {"definition": draft})
        recipe = {"recipe": "building-envelope", "version": 1, "aboveBaseOnly": True, "exclusions": ["site"]}
        out = rt.mapping.propose("ex:Building", "derived", recipe, text="the envelope above the base", expected_revision=3)
        body = dg.requests[0]["body"]
        assert body == {"project": PROJECT, "classIri": "ex:Building", "kind": "derived", "recipe": recipe,
                        "text": "the envelope above the base", "expectedRevision": 3}
        assert out["definition"]["head"]["source"] == "agent" and out["definition"]["effective"]["version"] == 1
        assert revit.calls == [] and revit.native == []

    @pytest.mark.parametrize("kwargs", [
        {"kind": "frobnicated"}, {"class_iri": ""}, {"recipe": "not-a-dict"}, {"expected_revision": 0},
        {"expected_revision": True}, {"text": "x" * 2001}, {"recipe": {}}])
    def test_a_malformed_proposal_is_refused_before_any_request(self, rt, dg, revit, kwargs):
        args = {"class_iri": "ex:Building", "kind": "derived", "recipe": {"recipe": "building-envelope", "version": 1}}
        args.update(kwargs)
        with pytest.raises(ValueError):
            rt.mapping.propose(**args)
        assert dg.requests == [] and revit.calls == []

    def test_a_stale_proposal_keeps_the_servers_conflict(self, rt, dg):
        dg.routes["POST /data-service/mapping/definitions"] = (409, refusal("MAPPING_DEFINITION_CONFLICT"))
        with pytest.raises(DgRefused) as exc:
            rt.mapping.propose("ex:Building", "derived", {"recipe": "building-envelope", "version": 1},
                               expected_revision=2)
        assert exc.value.code == "MAPPING_DEFINITION_CONFLICT" and len(dg.requests) == 1

    def test_a_measurement_named_recipe_keeps_the_servers_422(self, rt, dg):
        dg.routes["POST /data-service/mapping/definitions"] = (422, refusal("MAPPING_DEFINITION_MEASUREMENT"))
        with pytest.raises(DgRefused) as exc:
            rt.mapping.propose("ex:Building", "derived", {"recipe": "building-envelope", "version": 1, "height": 3})
        assert exc.value.code == "MAPPING_DEFINITION_MEASUREMENT" and exc.value.status == 422

    def test_the_mode_is_a_revisioned_proposal_and_the_approval_stays_effective(self, rt, dg, revit):
        proposed = _definition(modeProposal={"mode": "ordinary", "source": "member", "proposedBy": "alice"})
        dg.routes["POST /data-service/mapping/definitions/mode"] = (200, {"definition": proposed})
        reply = rpc("degram.mapping.advanced.mode", {"definitionId": DEF, "mode": "ordinary", "expectedRevision": 3,
                                                     "reason": "back to the ordinary flow"})["result"]
        assert dg.requests[0]["body"] == {"project": PROJECT, "definitionId": DEF, "mode": "ordinary",
                                          "reason": "back to the ordinary flow", "expectedRevision": 3}
        assert reply["status"] == "ok" and reply["definition"]["modeProposal"]["mode"] == "ordinary"
        assert reply["definition"]["mode"] == "advanced" and reply["definition"]["effective"]["version"] == 1
        assert revit.calls == [] and revit.native == []

    @pytest.mark.parametrize("params", [
        {"definitionId": "MD-1", "mode": "ordinary", "expectedRevision": 3},
        {"definitionId": DEF, "mode": "turbo", "expectedRevision": 3},
        {"definitionId": DEF, "mode": "ordinary", "expectedRevision": 0},
        {"definitionId": DEF, "mode": "ordinary"}])
    def test_a_malformed_mode_change_is_refused_before_dg(self, rt, dg, params):
        reply = rpc("degram.mapping.advanced.mode", params)
        assert "error" in reply and dg.requests == []

    def test_a_mode_conflict_is_the_servers_conflict(self, rt, dg):
        dg.routes["POST /data-service/mapping/definitions/mode"] = (409, refusal("MAPPING_DEFINITION_CONFLICT"))
        reply = rpc("degram.mapping.advanced.mode", {"definitionId": DEF, "mode": "advanced", "expectedRevision": 3})
        assert reply["error"]["data"] == {"code": "MAPPING_DEFINITION_CONFLICT", "status": 409}


def _derive_routes(dg, status=None, session=None) -> None:
    dg.routes[f"{BASE}/{RSID}"] = (200, session if session is not None else _revit_session())
    dg.routes[f"POST {BASE}/{RSID}/advanced/derive"] = (200, {
        "requestId": REQ, "requestHash": "9" * 64, "request": {"requestId": REQ, "definitionId": DEF},
        "bindingRevision": 4})
    dg.routes[f"{BASE}/{RSID}/advanced/derive/{REQ}"] = (200, status or {
        "status": "completed", "requestId": REQ, "definitionId": DEF, "resultStatus": "ok", "resultHash": RESULT_HASH,
        "bindingRevision": 5, "change": "changed"})


class TestDerive:
    @pytest.mark.parametrize("result_status", ["failed", "needs-input"])
    def test_agent_proposal_then_ui_derive_reports_failure_back_to_agent(self, rt, dg, revit, pinned, result_status):
        import tools.degram_tools
        from tools.registry import registry

        dg.routes["POST /data-service/mapping/definitions"] = (200, {"definition": _definition()})
        proposed = registry.dispatch("degram_mapping", {"action": "propose", "classIri": "ex:Building",
            "kind": "derived", "recipe": {"recipe": "building-envelope", "version": 1}})
        proposed = json.loads(proposed) if isinstance(proposed, str) else proposed
        assert proposed["definition"]["effective"]["version"] == 1
        _derive_routes(dg, status={"status": "completed", "requestId": REQ, "definitionId": DEF,
            "resultStatus": result_status, "resultHash": RESULT_HASH, "bindingRevision": 5})
        revit.handlers["dg_derive_definition"] = {"derived": True}
        derived = rpc("degram.mapping.advanced.derive", {"sessionId": RSID, "definitionId": DEF,
                                                       "requestId": REQ})["result"]
        assert derived["outcome"] == result_status and derived["ok"] is False
        session = _revit_session()
        session["advanced"]["bindings"][0]["resultStatus"] = result_status
        dg.routes[f"{BASE}/{RSID}"] = (200, session)
        raw = registry.dispatch("degram_mapping", {"action": "advanced", "sessionId": RSID})
        out = json.loads(raw) if isinstance(raw, str) else raw
        assert out["bindings"][0]["resultStatus"] == result_status
        assert out["bindings"][0]["approved"]["definitionVersion"] == 1
        assert _writes(dg) == ["POST /data-service/mapping/definitions", f"POST {BASE}/{RSID}/advanced/derive"]
        assert revit.native == []

    def test_the_canonical_request_is_frozen_derived_by_the_connector_and_read_back(self, rt, dg, revit, pinned):
        _derive_routes(dg)
        revit.handlers["dg_derive_definition"] = {"status": "ok", "derived": True, "requestId": REQ,
                                                  "resultStatus": "ok"}
        out = rt.mapping.derive(RSID, DEF, REQ, definition_version=2, expected_binding_revision=4)
        assert _writes(dg) == [f"POST {BASE}/{RSID}/advanced/derive"]
        assert dg.requests[1]["body"] == {"project": PROJECT, "definitionId": DEF, "requestId": REQ,
                                          "definitionVersion": 2, "expectedBindingRevision": 4}
        assert [c["tool"] for c in revit.calls] == ["list_open_documents", "dg_derive_definition"]
        assert revit.calls[1]["arguments"] == {"request_id": REQ}, "only the id; the request is DG's, not the caller's"
        assert (out["outcome"], out["resultStatus"], out["resultHash"], out["change"]) == ("ok", "ok", RESULT_HASH,
                                                                                         "changed")
        assert out["requestId"] == REQ and out["requestHash"] == "9" * 64 and out["bindingRevision"] == 5

    def test_the_rpc_shape_is_the_contract(self, rt, dg, revit, pinned):
        _derive_routes(dg)
        revit.handlers["dg_derive_definition"] = {"status": "ok", "derived": True}
        reply = rpc("degram.mapping.advanced.derive", {"sessionId": RSID, "definitionId": DEF, "requestId": REQ,
                                                       "definitionVersion": 2})["result"]
        assert reply["status"] == "ok" and reply["outcome"] == "ok" and reply["requestId"] == REQ

    def test_rpc_forwards_model_local_correction_only_to_the_frozen_derive(self, rt, dg, revit, pinned):
        _derive_routes(dg)
        revit.handlers["dg_derive_definition"] = {"status": "ok", "derived": True}
        binding = {"grids": ["A/1", "B/2"], "phaseScope": "all-model"}
        reply = rpc("degram.mapping.advanced.derive", {"sessionId": RSID, "definitionId": DEF, "requestId": REQ,
                    "definitionVersion": 2, "expectedBindingRevision": 4, "binding": binding})["result"]
        assert reply["outcome"] == "ok"
        body = next(r["body"] for r in dg.requests if r.get("method") == "POST")
        assert body["binding"] == binding and body["expectedBindingRevision"] == 4
        assert revit.calls[-1]["arguments"] == {"request_id": REQ}

    @pytest.mark.parametrize("result_status", ["failed", "needs-input"])
    def test_a_failed_or_needs_input_result_is_explicit_never_ok(self, rt, dg, revit, pinned, result_status):
        _derive_routes(dg, status={"status": "completed", "requestId": REQ, "definitionId": DEF,
                                   "resultStatus": result_status, "resultHash": RESULT_HASH, "bindingRevision": 5,
                                   "change": "none"})
        revit.handlers["dg_derive_definition"] = {"status": "ok", "derived": True, "resultStatus": result_status}
        out = rt.mapping.derive(RSID, DEF, REQ)
        assert out["outcome"] == result_status and out["ok"] is False

    def test_the_connector_not_posting_a_result_is_reported_not_hidden(self, rt, dg, revit, pinned):
        _derive_routes(dg, status={"status": "pending", "requestId": REQ, "requestHash": "9" * 64,
                                   "request": {"requestId": REQ}, "bindingRevision": 4})
        revit.handlers["dg_derive_definition"] = {"status": "ok", "derived": False, "code": "DOCUMENT_NOT_OPEN",
                                                  "message": "The model of the mapping session is not open"}
        out = rt.mapping.derive(RSID, DEF, REQ)
        assert out["outcome"] == "pending" and out["ok"] is False
        assert out["nativeCode"] == "DOCUMENT_NOT_OPEN"

    def test_a_timeout_is_unresolved_with_a_status_link_and_the_connector_is_not_asked_twice(self, rt, dg, revit, pinned):
        _derive_routes(dg, status={"status": "pending", "requestId": REQ, "requestHash": "9" * 64,
                                   "request": {"requestId": REQ}, "bindingRevision": 4})
        revit.handlers["dg_derive_definition"] = BridgeError("BUSY", "NO_RESPONSE", "Revit did not answer in time.")
        out = rt.mapping.derive(RSID, DEF, REQ)
        assert out["outcome"] == "unresolved" and out["requestId"] == REQ
        assert out["statusLink"] == {"route": "advanced-derive-status", "sessionId": RSID, "requestId": REQ}
        assert [c["tool"] for c in revit.calls].count("dg_derive_definition") == 1

    def test_the_status_only_read_never_asks_revit(self, rt, dg, revit, pinned):
        _derive_routes(dg)
        reply = rpc("degram.mapping.advanced.derive", {"sessionId": RSID, "definitionId": DEF, "requestId": REQ,
                                                       "statusOnly": True})["result"]
        assert reply["outcome"] == "ok" and revit.calls == [] and revit.native == []
        assert _writes(dg) == [], "a status read posts nothing"

    @pytest.mark.parametrize("case", ["no-pin", "other-document", "other-platform", "closed"])
    def test_another_model_or_no_pin_is_refused_before_any_request_or_tool(self, rt, dg, revit, case):
        if case != "no-pin":
            rt.documents._sources["revit"] = _Source()
            rt.documents.pin("revit", dict(IDENTITY))
        session = _revit_session()
        if case == "other-document":
            session["document"] = "annex"
        if case == "other-platform":
            session["platform"] = "grasshopper"
        _derive_routes(dg, session=session)
        if case == "closed":
            revit.handlers["list_open_documents"] = {"status": "ok", "documents": []}
        with pytest.raises(BridgeError) as exc:
            rt.mapping.derive(RSID, DEF, REQ)
        assert exc.value.code in ("IDENTITY_MISMATCH", "DOCUMENT_NOT_OPEN")
        assert "dg_derive_definition" not in [c["tool"] for c in revit.calls]
        assert _writes(dg) == []

    def test_a_foreign_project_or_model_argument_is_refused_before_anything(self, rt, dg, revit, pinned):
        _derive_routes(dg)
        with pytest.raises(ValueError):
            rt.mapping.derive(RSID, DEF, REQ, project="foreign")
        with pytest.raises(BridgeError) as exc:
            rt.mapping.derive(RSID, DEF, REQ, model={"creationGuid": "ffffffff-0000-0000-0000-000000000009",
                                                    "pathName": "C:\\other.rvt"})
        assert exc.value.code == "IDENTITY_MISMATCH"
        assert dg.requests == [] and revit.calls == []

    @pytest.mark.parametrize("kwargs", [{"request_id": "x"}, {"request_id": "a b"}, {"definition_id": "MD-1"},
                                        {"definition_version": 0}, {"expected_binding_revision": -1},
                                        {"binding": "nope"}])
    def test_malformed_ids_are_refused_before_dg(self, rt, dg, revit, pinned, kwargs):
        args = {"session_id": RSID, "definition_id": DEF, "request_id": REQ}
        args.update(kwargs)
        with pytest.raises(ValueError):
            rt.mapping.derive(**args)
        assert dg.requests == []

    def test_no_code_path_posts_a_result_for_the_caller(self, rt, dg, revit, pinned):
        """The connector alone posts a derive result; this client has no way to, in any flow."""
        assert not [n for n in dir(DgClient) if "result" in n and "derive" in n]
        _derive_routes(dg)
        revit.handlers["dg_derive_definition"] = {"status": "ok", "derived": True}
        rt.mapping.derive(RSID, DEF, REQ)
        rt.mapping.advanced_state(RSID)
        assert not [p for p in _writes(dg) if p.endswith("/advanced/result")]

    def test_a_reply_after_the_scope_changed_is_dropped(self, rt, dg, revit, pinned):
        _derive_routes(dg)

        def switch(args):
            info = credentials.info()
            credentials.set(token="dgd_other_environment_token", expires_at=time.time() + 600,
                            relay_base_url=info.relay_base_url, user="bob", company="acme", project="annex")
            credentials.set(token=TOKEN, expires_at=time.time() + 600, relay_base_url=info.relay_base_url,
                            user="alice", company="acme", project=PROJECT)
            return {"status": "ok", "derived": True}

        revit.handlers["dg_derive_definition"] = switch
        with pytest.raises(BridgeError) as exc:
            rt.mapping.derive(RSID, DEF, REQ)
        assert (exc.value.code, exc.value.reason) == ("CANCELLED", "SCOPE_CHANGED")
        assert dg.paths()[-1] != f"{BASE}/{RSID}/advanced/derive/{REQ}?project=tower", "the status was not read after"

    def test_a_pin_change_during_the_call_drops_the_reply(self, rt, dg, revit, pinned):
        _derive_routes(dg)
        revit.handlers["dg_derive_definition"] = lambda args: (rt.documents.unpin("revit"),
                                                               {"status": "ok", "derived": True})[1]
        with pytest.raises(BridgeError) as exc:
            rt.mapping.derive(RSID, DEF, REQ)
        assert (exc.value.code, exc.value.reason) == ("CANCELLED", "SCOPE_CHANGED")


class TestOverviewAndSelection:
    def test_the_pinned_active_model_is_read(self, rt, dg, revit, pinned):
        revit.handlers["dg_model_overview"] = {"status": "ok", "grids": ["A", "1"], "levels": []}
        revit.handlers["dg_read_selection"] = {"status": "ok", "uniqueIds": ["uid-1"], "matched": 1,
                                               "truncated": False}
        overview = rt.mapping.overview()
        selection = rt.mapping.selection()
        assert overview["grids"] == ["A", "1"] and selection["uniqueIds"] == ["uid-1"]
        assert overview["model"]["name"] == "tower.rvt" and "creationGuid" not in json.dumps(overview["model"])
        assert dg.requests == []

    @pytest.mark.parametrize("which", ["overview", "selection"])
    def test_without_a_pin_nothing_is_read(self, rt, dg, revit, which):
        with pytest.raises(BridgeError) as exc:
            getattr(rt.mapping, which)()
        assert exc.value.code == "DOCUMENT_NOT_OPEN"
        assert revit.calls == []

    @pytest.mark.parametrize("which", ["overview", "selection"])
    def test_another_active_model_is_refused_before_the_read(self, rt, dg, revit, pinned, which):
        revit.handlers["list_open_documents"] = _open_documents(active=False)
        with pytest.raises(BridgeError) as exc:
            getattr(rt.mapping, which)()
        assert exc.value.code == "IDENTITY_MISMATCH"
        assert [c["tool"] for c in revit.calls] == ["list_open_documents"]

    @pytest.mark.parametrize("which", ["overview", "selection"])
    def test_a_foreign_project_or_model_argument_is_refused_before_any_tool(self, rt, dg, revit, pinned, which):
        with pytest.raises(ValueError):
            getattr(rt.mapping, which)(project="foreign")
        with pytest.raises(BridgeError):
            getattr(rt.mapping, which)(model={"creationGuid": "ffffffff-0000-0000-0000-000000000009",
                                              "pathName": "C:\\other.rvt"})
        assert revit.calls == [] and dg.requests == []

    @pytest.mark.parametrize("which,tool", [("overview", "dg_model_overview"), ("selection", "dg_read_selection")])
    def test_the_model_changing_during_the_read_drops_the_reply(self, rt, dg, revit, pinned, which, tool):
        revit.handlers[tool] = lambda args: (setattr(revit, "handlers", {**revit.handlers,
                                                                          "list_open_documents": _open_documents(False)}),
                                             {"status": "ok", "grids": [], "uniqueIds": []})[1]
        with pytest.raises(BridgeError) as exc:
            getattr(rt.mapping, which)()
        assert exc.value.code in ("IDENTITY_MISMATCH", "CANCELLED")


# -- 5. protected answers, proofs and the common commit ------------------------------------------------------------


class TestAdvancedAnswer:
    PARAMS = {"sessionId": RSID, "requestId": "r-answer-1", "intentId": INTENT, "action": "approve",
              "scope": APPROVE_SCOPE}

    def test_a_confirmed_matching_proof_posts_the_exact_answer(self, rt, dg, revit):
        _routes(dg, intent=_intent("advanced-approve", APPROVE_SCOPE))
        dg.routes[f"POST {BASE}/{RSID}/advanced/answer"] = (200, _revit_session())
        reply = rpc("degram.mapping.advanced.answer", self.PARAMS)["result"]
        assert reply["status"] == "ok" and reply["session"]["sessionId"] == RSID
        assert reply["session"]["advancedState"]["agentDefinitionClasses"] == ["ex:Building"]
        assert dg.requests[-1]["body"] == {"project": PROJECT, "requestId": "r-answer-1", "intentId": INTENT,
                                           "action": "approve", "scope": APPROVE_SCOPE}
        assert revit.calls == [] and revit.native == []

    def test_a_skip_uses_the_skip_proof(self, rt, dg):
        _routes(dg, intent=_intent("advanced-skip", SKIP_SCOPE))
        dg.routes[f"POST {BASE}/{RSID}/advanced/answer"] = (200, _revit_session())
        out = rt.mapping.answer_advanced(RSID, "r-skip-1", INTENT, "skip", SKIP_SCOPE)
        assert dg.requests[-1]["body"]["action"] == "skip" and out["sessionId"] == RSID

    @pytest.mark.parametrize("case,intent", [
        ("pending", _intent("advanced-approve", APPROVE_SCOPE, status="pending")),
        ("cancelled", _intent("advanced-approve", APPROVE_SCOPE, status="cancelled")),
        ("consumed", _intent("advanced-approve", APPROVE_SCOPE, status="consumed")),
        ("expired", _intent("advanced-approve", APPROVE_SCOPE, status="expired")),
        ("stale", _intent("advanced-approve", APPROVE_SCOPE, status="stale")),
        ("revoked", _intent("advanced-approve", APPROVE_SCOPE, status="revoked")),
        ("claimed", _intent("advanced-approve", APPROVE_SCOPE, status="claimed")),
        ("other-action", _intent("advanced-skip", APPROVE_SCOPE)),
        ("preview-proof", _intent("preview-definition", APPROVE_SCOPE)),
        ("other-scope", _intent("advanced-approve", {**APPROVE_SCOPE, "resultHash": "f" * 64})),
        ("other-session", _intent("advanced-approve", APPROVE_SCOPE, sessionId="ms-other")),
        ("other-project", _intent("advanced-approve", APPROVE_SCOPE, project="annex")),
        ("other-id", _intent("advanced-approve", APPROVE_SCOPE, intentId="hi-ffffffffffffffffffffffff"))])
    def test_a_proof_that_is_not_confirmed_for_exactly_this_is_refused_before_posting(self, rt, dg, case, intent):
        _routes(dg, intent=intent)
        dg.routes[f"POST {BASE}/{RSID}/advanced/answer"] = (200, _revit_session())
        with pytest.raises(DgRefused) as exc:
            rt.mapping.answer_advanced(RSID, "r-answer-1", INTENT, "approve", APPROVE_SCOPE)
        assert exc.value.code in ("INTENT_NOT_CONFIRMED", "INTENT_HASH_CONFLICT", "INTENT_REQUIRED"), case
        assert _writes(dg) == []

    @pytest.mark.parametrize("flag", ["confirmed", "byAgent", "actor", "issuedBy", "status", "decision", "CONFIRMED",
                                      " confirmed"])
    def test_a_proof_flag_inside_the_scope_is_refused_before_any_request(self, rt, dg, flag):
        _routes(dg, intent=_intent("advanced-approve", APPROVE_SCOPE))
        with pytest.raises(ValueError):
            rt.mapping.answer_advanced(RSID, "r-answer-1", INTENT, "approve", {**APPROVE_SCOPE, flag: True})
        with pytest.raises(ValueError):
            rt.mapping.answer_advanced(RSID, "r-answer-1", INTENT, "approve",
                                       {**APPROVE_SCOPE, "nested": {"deep": {flag: "yes"}}})
        assert dg.requests == []

    @pytest.mark.parametrize("kwargs", [{"intent_id": ""}, {"intent_id": "x"}, {"action": "apply"},
                                        {"action": "approve "}, {"action": None}, {"scope": []}, {"scope": None},
                                        {"request_id": "x"}, {"session_id": ""}])
    def test_malformed_arguments_are_refused_before_dg(self, rt, dg, kwargs):
        args = {"session_id": RSID, "request_id": "r-answer-1", "intent_id": INTENT, "action": "approve",
                "scope": APPROVE_SCOPE}
        args.update(kwargs)
        with pytest.raises((ValueError, DgRefused)):
            rt.mapping.answer_advanced(**args)
        assert dg.requests == []

    def test_the_server_remains_the_authority_when_it_refuses_a_spent_proof(self, rt, dg):
        _routes(dg, intent=_intent("advanced-approve", APPROVE_SCOPE))
        dg.routes[f"POST {BASE}/{RSID}/advanced/answer"] = (409, refusal("INTENT_ALREADY_CONSUMED"))
        reply = rpc("degram.mapping.advanced.answer", self.PARAMS)
        assert reply["error"]["data"] == {"code": "INTENT_ALREADY_CONSUMED", "status": 409}


class TestBulkAnswer:
    scope = {"items": [
        {"definitionId": f"MD-{n:012x}", "definitionVersion": 2, "definitionRevision": 1,
         "modeRevision": 0, "bindingRevision": 4, "resultHash": "a" * 64}
        for n in (1, 2)
    ]}

    def test_matching_proof_posts_one_plural_request(self, rt, dg):
        _routes(dg, intent=_intent("advanced-bulk-approve", self.scope))
        dg.routes[f"POST {BASE}/{RSID}/advanced/answers"] = (200, _revit_session())
        out = rpc("degram.mapping.advanced.answers", {"sessionId": RSID, "requestId": "bulk-001",
                  "intentId": INTENT, "scope": self.scope})["result"]
        assert out["status"] == "ok" and out["session"]["sessionId"] == RSID
        assert dg.requests[-1]["body"] == {"project": PROJECT, "requestId": "bulk-001", "intentId": INTENT, "scope": self.scope}
        assert len(_writes(dg)) == 1

    def test_consumed_matching_request_reaches_server_idempotent_replay(self, rt, dg):
        _routes(dg, intent=_intent("advanced-bulk-approve", self.scope, status="consumed", consumedFor="bulk-001"))
        dg.routes[f"POST {BASE}/{RSID}/advanced/answers"] = (200, _revit_session())
        out = rt.mapping.answers_advanced(RSID, "bulk-001", INTENT, self.scope)
        assert out["sessionId"] == RSID
        assert len(_writes(dg)) == 1

    @pytest.mark.parametrize("spent_for", [None, "another-request"])
    def test_consumed_other_request_is_refused_before_post(self, rt, dg, spent_for):
        _routes(dg, intent=_intent("advanced-bulk-approve", self.scope, status="consumed", consumedFor=spent_for))
        with pytest.raises(DgRefused):
            rt.mapping.answers_advanced(RSID, "bulk-001", INTENT, self.scope)
        assert not _writes(dg)

    def test_wrong_proof_and_forged_tuples_are_refused(self, rt, dg):
        _routes(dg, intent=_intent("advanced-bulk-approve", self.scope, status="pending"))
        with pytest.raises(DgRefused):
            rt.mapping.answers_advanced(RSID, "bulk-001", INTENT, self.scope)
        assert not _writes(dg)
        with pytest.raises(ValueError):
            rt.mapping.answers_advanced(RSID, "bulk-001", INTENT, {"items": [self.scope["items"][0], {**self.scope["items"][1], "confirmed": True}]})
        assert not _writes(dg)


class TestCommonCommitProof:
    BASE_ARGS = {"sessionId": RSID, "requestId": "commit-1", "revision": "a" * 24, "answerIds": ["A-adv1", "A-ord1"]}

    def _batch(self, **over):
        return {"batchId": "commit-1", "revision": "a" * 24, "answerIds": ["A-adv1", "A-ord1"], "committedAt": "now",
                "delivery": {"state": "queued"}, **over}

    def test_a_matching_commit_proof_rides_with_the_apply(self, rt, dg):
        _routes(dg, intent=_intent("advanced-commit", COMMIT_SCOPE))
        dg.routes[f"POST {BASE}/{RSID}/apply"] = (200, self._batch())
        reply = rpc("degram.mapping.apply", {**self.BASE_ARGS, "intentId": INTENT})["result"]
        assert reply["status"] == "ok" and reply["batch"]["delivery"] == {"state": "queued"}
        body = dg.requests[-1]["body"]
        assert body["intentId"] == INTENT and not ({"receipt", "connectorProtocol"} & set(body))

    @pytest.mark.parametrize("case,intent,session", [
        ("wrong-manifest", _intent("advanced-commit", {"batchManifestHash": "f" * 64}), None),
        ("pending", _intent("advanced-commit", COMMIT_SCOPE, status="pending"), None),
        ("wrong-action", _intent("advanced-approve", COMMIT_SCOPE), None),
        ("consumed", _intent("advanced-commit", COMMIT_SCOPE, status="consumed"), None),
        ("no-commit-offered", _intent("advanced-commit", COMMIT_SCOPE),
         {**_revit_session(), "advanced": {**_revit_session()["advanced"], "commit": None}})])
    def test_a_proof_that_does_not_match_the_offered_commit_is_refused_before_posting(self, rt, dg, case, intent, session):
        _routes(dg, session=session, intent=intent)
        dg.routes[f"POST {BASE}/{RSID}/apply"] = (200, self._batch())
        with pytest.raises(DgRefused) as exc:
            rt.mapping.apply(RSID, "commit-1", "a" * 24, ["A-adv1", "A-ord1"], intent_id=INTENT)
        assert exc.value.code in ("INTENT_NOT_CONFIRMED", "INTENT_HASH_CONFLICT", "INTENT_REQUIRED"), case
        assert _writes(dg) == []

    @pytest.mark.parametrize("capabilities", [[], ["instances"], CAPABILITIES[:-1], [c for c in CAPABILITIES
                                                                                       if c != "native-intent"]])
    def test_an_old_connector_is_refused_whole_before_the_apply(self, rt, dg, capabilities):
        session = _revit_session()
        session["connector"]["target"]["capabilities"] = capabilities
        _routes(dg, session=session, intent=_intent("advanced-commit", COMMIT_SCOPE))
        dg.routes[f"POST {BASE}/{RSID}/apply"] = (200, self._batch())
        reply = rpc("degram.mapping.apply", {**self.BASE_ARGS, "intentId": INTENT})
        assert reply["error"]["data"]["code"] == "ADVANCED_DELIVERY_UNAVAILABLE"
        assert _writes(dg) == []

    def test_a_connector_that_is_not_supported_is_refused_whole(self, rt, dg):
        session = _revit_session()
        session["connector"]["target"]["supported"] = False
        _routes(dg, session=session, intent=_intent("advanced-commit", COMMIT_SCOPE))
        with pytest.raises(DgRefused) as exc:
            rt.mapping.apply(RSID, "commit-1", "a" * 24, ["A-adv1"], intent_id=INTENT)
        assert exc.value.code == "ADVANCED_DELIVERY_UNAVAILABLE" and _writes(dg) == []

    def test_an_ordinary_only_commit_is_unchanged(self, rt, dg):
        dg.routes[f"POST {BASE}/{RSID}/apply"] = (200, self._batch(answerIds=["A-ord1"]))
        reply = rpc("degram.mapping.apply", {**self.BASE_ARGS, "answerIds": ["A-ord1"]})["result"]
        assert reply["status"] == "ok" and len(dg.requests) == 1 and "intentId" not in dg.requests[0]["body"]

    def test_an_unconfirmed_delivery_is_kept_not_turned_into_a_success(self, rt, dg):
        _routes(dg, intent=_intent("advanced-commit", COMMIT_SCOPE))
        for state in ("unknown", "undone"):
            dg.routes[f"POST {BASE}/{RSID}/apply"] = (200, self._batch(delivery={"state": state}))
            reply = rpc("degram.mapping.apply", {**self.BASE_ARGS, "intentId": INTENT})["result"]
            assert reply["batch"]["delivery"] == {"state": state}


class TestAdvancedState:
    def test_exact_confirmation_and_affected_models_survive_the_gateway_projection(self, rt, dg):
        session = _revit_session()
        rows = {"elements": [{"nativeId": "u1", "roles": [], "clear": True}], "parameters": [], "measures": []}
        affected = [{"definitionId": DEF, "modelKey": "other-key", "document": "Other"}]
        session["advanced"]["commit"]["ordinaryRows"] = rows
        session["advanced"]["affectedModels"] = affected
        dg.routes[f"{BASE}/{RSID}"] = (200, session)
        state = rt.mapping.advanced_state(RSID)
        assert state["commit"]["ordinaryRows"] == rows
        assert state["affectedModels"] == affected

    def test_the_state_reads_versions_hashes_model_capabilities_and_distinct_phases(self, rt, dg):
        dg.routes[f"{BASE}/{RSID}"] = (200, _revit_session())
        state = rt.mapping.advanced_state(RSID)
        assert state["revision"] == "r" * 24
        (definition,) = state["definitions"]
        assert definition["head"]["version"] == 2 and definition["effective"]["version"] == 1
        assert definition["agentProposed"] is True and definition["modeProposedByAgent"] is False
        assert state["agentDefinitionClasses"] == ["ex:Building"]
        (binding,) = state["bindings"]
        assert binding["resultHash"] == RESULT_HASH and binding["resultDefinitionVersion"] == 2
        assert binding["confirmation"] == "pending-answer" and binding["delivery"] == "queued"
        assert state["commit"]["batchManifestHash"] == MANIFEST_HASH
        assert state["model"] == {"document": "tower", "modelKey": "tower-key"}
        assert state["capabilities"] == CAPABILITIES and state["supported"] is True and state["complete"] is True
        assert state["delivery"] == {"batchId": "commit-1", "state": "queued"} and state["snapshot"] is None

    def test_the_state_marks_an_incomplete_connector(self, rt, dg):
        session = _revit_session()
        session["connector"]["target"]["capabilities"] = ["instances"]
        dg.routes[f"{BASE}/{RSID}"] = (200, session)
        state = rt.mapping.advanced_state(RSID)
        assert state["complete"] is False and state["missingCapabilities"] == CAPABILITIES[1:]

    def test_a_session_without_the_section_has_no_advanced_state(self, rt, dg):
        dg.routes[f"{BASE}/{RSID}"] = (200, {**REVIT_SESSION})
        session = rt.mapping.session(RSID)
        assert "advancedState" not in session
        state = rt.mapping.advanced_state(RSID)
        assert state["definitions"] == [] and state["commit"] is None and state["complete"] is False

    def test_the_session_read_carries_the_state_for_both_surfaces(self, rt, dg):
        dg.routes[f"{BASE}/{RSID}"] = (200, _revit_session())
        session = rpc("degram.mapping.session", {"sessionId": RSID})["result"]["session"]
        assert session["advancedState"]["agentDefinitionClasses"] == ["ex:Building"]
        assert "elements" not in session

    def test_a_pending_draft_does_not_invalidate_the_effective_version(self, rt, dg):
        """Q5: approved and draft coexist; the draft is shown as a draft and the approved binding is untouched."""
        dg.routes[f"{BASE}/{RSID}"] = (200, _revit_session())
        state = rt.mapping.advanced_state(RSID)
        (binding,) = state["bindings"]
        assert binding["approved"]["definitionVersion"] == 1 and state["definitions"][0]["head"]["status"] == "draft"
        assert state["definitions"][0]["effective"]["status"] == "approved"


# -- 6. confirm, preview and clear: the broker's native doors -----------------------------------------------------


class TestNativeHumanDoors:
    def test_confirm_dispatches_the_native_dialog_once_for_a_pending_challenge(self, rt, dg, revit):
        _routes(dg, intent=_intent("advanced-approve", APPROVE_SCOPE, status="pending"))
        revit.handlers["dg_confirm_mapping_intent"] = {"status": "ok", "decision": "confirmed",
                                                      "intent": {"intentId": INTENT, "status": "confirmed"}}
        reply = rpc("degram.mapping.advanced.confirmIntent", {"sessionId": RSID, "intentId": INTENT,
                                                              "scope": APPROVE_SCOPE})["result"]
        assert reply["status"] == "ok" and reply["decision"] == "confirmed"
        assert reply["intent"]["intentId"] == INTENT
        assert revit.native == [{"tool": "dg_confirm_mapping_intent", "arguments": {"intent_id": INTENT}}]
        assert revit.calls == [], "the agent door was not used"
        assert _writes(dg) == [], "Python never posts a receipt: only the native dialog does"

    def test_a_cancelled_dialog_is_reported_as_cancelled_and_grants_nothing(self, rt, dg, revit):
        _routes(dg, intent=_intent("advanced-approve", APPROVE_SCOPE, status="pending"))
        revit.handlers["dg_confirm_mapping_intent"] = {"status": "ok", "decision": "cancelled",
                                                      "intent": {"intentId": INTENT, "status": "cancelled"}}
        reply = rpc("degram.mapping.advanced.confirmIntent", {"sessionId": RSID, "intentId": INTENT,
                                                              "scope": APPROVE_SCOPE})["result"]
        assert reply["decision"] == "cancelled" and reply["outcome"] == "cancelled"

    @pytest.mark.parametrize("decision", [True, "yes", "Confirmed", 1, None, "confirmed "])
    def test_only_the_exact_word_is_a_confirmation(self, rt, dg, revit, decision):
        _routes(dg, intent=_intent("advanced-approve", APPROVE_SCOPE, status="pending"))
        revit.handlers["dg_confirm_mapping_intent"] = {"status": "ok", "decision": decision, "intent": {}}
        reply = rpc("degram.mapping.advanced.confirmIntent", {"sessionId": RSID, "intentId": INTENT,
                                                              "scope": APPROVE_SCOPE})["result"]
        assert reply["decision"] == "cancelled"

    @pytest.mark.parametrize("case,intent", [
        ("confirmed", _intent("advanced-approve", APPROVE_SCOPE, status="confirmed")),
        ("cancelled", _intent("advanced-approve", APPROVE_SCOPE, status="cancelled")),
        ("expired", _intent("advanced-approve", APPROVE_SCOPE, status="expired")),
        ("other-scope", _intent("advanced-approve", {**APPROVE_SCOPE, "definitionVersion": 9}, status="pending")),
        ("other-session", _intent("advanced-approve", APPROVE_SCOPE, status="pending", sessionId="ms-other")),
        ("other-project", _intent("advanced-approve", APPROVE_SCOPE, status="pending", project="annex")),
        ("unknown-action", _intent("advanced-delete", APPROVE_SCOPE, status="pending"))])
    def test_a_challenge_that_is_not_pending_for_this_scope_never_opens_a_dialog(self, rt, dg, revit, case, intent):
        _routes(dg, intent=intent)
        with pytest.raises(DgRefused) as exc:
            rt.mapping.confirm_intent(RSID, INTENT, APPROVE_SCOPE)
        assert exc.value.code in ("INTENT_NOT_PENDING", "INTENT_HASH_CONFLICT"), case
        assert revit.native == []

    def test_pin_change_during_native_dialog_drops_reply(self, rt, dg, revit, pinned):
        _routes(dg, intent=_intent("advanced-approve", APPROVE_SCOPE, status="pending"))
        def moved(args):
            rt.documents.unpin("revit")
            return {"decision": "confirmed", "intent": {"intentId": INTENT, "status": "confirmed"}}
        revit.handlers["dg_confirm_mapping_intent"] = moved
        with pytest.raises(BridgeError) as exc:
            rt.mapping.confirm_intent(RSID, INTENT, APPROVE_SCOPE)
        assert (exc.value.code, exc.value.reason) == ("CANCELLED", "SCOPE_CHANGED")
        assert exc.value.extra["unresolved"] is True
        assert _writes(dg) == []

    def test_the_scope_echo_is_required(self, rt, dg, revit):
        _routes(dg, intent=_intent("advanced-approve", APPROVE_SCOPE, status="pending"))
        reply = rpc("degram.mapping.advanced.confirmIntent", {"sessionId": RSID, "intentId": INTENT})
        assert "error" in reply and revit.native == [] and dg.requests == []

    def test_a_dialog_is_never_opened_twice_for_one_challenge(self, rt, dg, revit):
        _routes(dg, intent=_intent("advanced-approve", APPROVE_SCOPE, status="pending"))
        revit.handlers["dg_confirm_mapping_intent"] = BridgeError("BUSY", "NATIVE_OUTCOME_UNRESOLVED", "no answer",
                                                                  unresolved=True)
        with pytest.raises(BridgeError) as first:
            rt.mapping.confirm_intent(RSID, INTENT, APPROVE_SCOPE)
        assert first.value.to_dict()["unresolved"] is True
        assert first.value.to_dict()["intent"]["intentId"] == INTENT, "the status of the challenge rides with it"
        with pytest.raises(DgRefused) as second:
            rt.mapping.confirm_intent(RSID, INTENT, APPROVE_SCOPE)
        assert second.value.code == "INTENT_ALREADY_DISPATCHED"
        assert len(revit.native) == 1

    @pytest.mark.parametrize("method,action,tool", [
        ("preview", "preview-definition", "dg_preview_definition"),
        ("clear_preview", "clear-definition-preview", "dg_clear_definition_preview")])
    def test_preview_and_clear_run_the_native_step_once_for_a_confirmed_intent(self, rt, dg, revit, method, action, tool):
        _routes(dg, intent=_intent(action, PREVIEW_SCOPE))
        revit.handlers[tool] = {"status": "ok", "outcome": "completed", "operationId": "OP-0123456789abcdef"}
        out = getattr(rt.mapping, method)(RSID, INTENT)
        assert out["outcome"] == "completed" and out["operationId"] == "OP-0123456789abcdef"
        assert revit.native == [{"tool": tool, "arguments": {"intent_id": INTENT}}]
        assert _writes(dg) == []
        with pytest.raises(DgRefused) as again:
            getattr(rt.mapping, method)(RSID, INTENT)
        assert again.value.code == "INTENT_ALREADY_DISPATCHED" and len(revit.native) == 1

    def test_the_rpc_names_map_to_the_native_tools(self, rt, dg, revit):
        for name, action, tool in (("degram.mapping.advanced.preview", "preview-definition", "dg_preview_definition"),
                                   ("degram.mapping.advanced.clearPreview", "clear-definition-preview",
                                    "dg_clear_definition_preview")):
            _routes(dg, intent=_intent(action, PREVIEW_SCOPE))
            revit.handlers[tool] = {"status": "ok", "outcome": "completed", "operationId": "OP-0123456789abcdef"}
            reply = rpc(name, {"sessionId": RSID, "intentId": INTENT})["result"]
            assert reply["status"] == "ok" and reply["outcome"] == "completed", name
            rt.mapping._dispatched.clear()
        assert [n["tool"] for n in revit.native] == ["dg_preview_definition", "dg_clear_definition_preview"]

    @pytest.mark.parametrize("method,wrong_action", [("preview", "clear-definition-preview"),
                                                       ("clear_preview", "preview-definition"),
                                                       ("preview", "advanced-approve"),
                                                       ("clear_preview", "advanced-commit")])
    def test_a_proof_for_another_action_never_runs_a_native_step(self, rt, dg, revit, method, wrong_action):
        _routes(dg, intent=_intent(wrong_action, PREVIEW_SCOPE))
        with pytest.raises(DgRefused):
            getattr(rt.mapping, method)(RSID, INTENT)
        assert revit.native == []

    @pytest.mark.parametrize("status", ["pending", "cancelled", "claimed", "consumed", "expired", "stale", "revoked"])
    def test_a_preview_needs_a_confirmed_unclaimed_challenge(self, rt, dg, revit, status):
        _routes(dg, intent=_intent("preview-definition", PREVIEW_SCOPE, status=status))
        with pytest.raises(DgRefused) as exc:
            rt.mapping.preview(RSID, INTENT)
        spent = status in ("claimed", "consumed")
        assert exc.value.code == ("INTENT_ALREADY_CLAIMED" if spent else "INTENT_NOT_CONFIRMED"), status
        assert revit.native == []

    def test_a_native_timeout_reports_the_unresolved_outcome_with_a_status_link_and_does_not_repeat(self, rt, dg, revit):
        _routes(dg, intent=_intent("preview-definition", PREVIEW_SCOPE))
        revit.handlers["dg_preview_definition"] = BridgeError("BUSY", "NATIVE_OUTCOME_UNRESOLVED", "no answer in time",
                                                              unresolved=True)
        reply = rpc("degram.mapping.advanced.preview", {"sessionId": RSID, "intentId": INTENT})["result"]
        assert reply["status"] == "error" and reply["code"] == "BUSY" and reply["unresolved"] is True
        assert reply["statusLink"] == {"route": "human-intent", "sessionId": RSID, "intentId": INTENT}
        assert reply["intent"]["intentId"] == INTENT
        again = rpc("degram.mapping.advanced.preview", {"sessionId": RSID, "intentId": INTENT})
        assert again["error"]["data"]["code"] == "INTENT_ALREADY_DISPATCHED"
        assert len(revit.native) == 1

    def test_a_scope_switch_during_the_native_call_drops_the_reply(self, rt, dg, revit):
        _routes(dg, intent=_intent("preview-definition", PREVIEW_SCOPE))

        def switch(args):
            credentials.clear()
            return {"status": "ok", "outcome": "completed"}

        revit.handlers["dg_preview_definition"] = switch
        with pytest.raises(BridgeError) as exc:
            rt.mapping.preview(RSID, INTENT)
        assert exc.value.code == "CANCELLED" and exc.value.reason == "SCOPE_CHANGED"

    def test_malformed_intent_ids_never_reach_dg_or_the_connector(self, rt, dg, revit):
        for bad in ("", "x", "a b", "hi-" + "x" * 200, "../etc", None, 7):
            with pytest.raises((ValueError, DgRefused)):
                rt.mapping.preview(RSID, bad)
        assert dg.requests == [] and revit.native == []


class TestClientRoutes:
    def test_the_client_has_the_routes_of_the_framework_half_and_no_result_poster(self, rt, dg):
        client = DgClient()
        dg.routes["/data-service/mapping/definitions"] = (200, {"definitions": [], "bindings": []})
        client.get_definitions()
        assert dg.requests[-1]["path"] == "/data-service/mapping/definitions?project=tower"
        dg.routes[f"{BASE}/{RSID}/human-intents/{INTENT}"] = (200, _intent("advanced-skip", SKIP_SCOPE))
        client.get_human_intent(RSID, INTENT)
        assert dg.requests[-1]["path"] == f"{BASE}/{RSID}/human-intents/{INTENT}?project=tower"
        assert all(r["headers"]["Authorization"] == f"Bearer {TOKEN}" for r in dg.requests)
        public = [n for n in dir(client) if not n.startswith("_")]
        assert not [n for n in public if n in ("post_result", "post_derive_result", "post_advanced_result",
                                               "issue_intent", "create_intent", "claim_intent", "post_intent_result")]

    @pytest.mark.parametrize("bad", ["", "x", "a b", "../etc", "hi-" + "x" * 200])
    def test_the_client_validates_ids_itself_before_sending(self, lite, bad):
        client = DgClient()
        for call in (lambda: client.get_human_intent(RSID, bad), lambda: client.get_human_intent(bad, INTENT),
                     lambda: client.derive_status(RSID, bad), lambda: client.request_derive(RSID, DEF, bad),
                     lambda: client.post_advanced_answer(RSID, "r-1", bad, "approve", {})):
            with pytest.raises(ValueError):
                call()  # `lite` fails the test if any of them had sent a request

    def test_a_422_of_the_new_routes_is_a_named_refusal(self, rt, dg):
        dg.routes["POST /data-service/mapping/definitions"] = (422, refusal("MAPPING_DEFINITION_NOT_PORTABLE"))
        with pytest.raises(DgRefused) as exc:
            DgClient().propose_definition("ex:Building", "derived", {"recipe": "building-envelope", "version": 1,
                                                                     "grid": "A"})
        assert (exc.value.status, exc.value.code) == (422, "MAPPING_DEFINITION_NOT_PORTABLE")
