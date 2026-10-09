"""Revit as a read-only MCP stdio child, document merge, bridge states and the degram toolset
(plan 1301-11 task 2; D-11, D-13, D-14, D-22, D-23).

The adapter is a fake MCP server over stdio (``fixtures/fake_revit_mcp.py``, real ``mcp`` SDK, no Revit)."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest

from degram_variant import profiles, revit_bridge
from utils import fast_safe_load
from degram_variant.lockdown import ALLOWED_TOOL_NAMES, DEGRAM_TOOL_NAMES, REVIT_TOOL_NAMES
from degram_variant.outcomes import BridgeError

from .conftest import GH_PIN, PROJECT, TOKEN, default_gh_handlers
from .fakes import GH_DOC_ID, gh_node

FAKE_SERVER = Path(__file__).parent / "fixtures" / "fake_revit_mcp.py"
REVIT_PIN = {"app": "revit", "identity": {"creationGuid": "aaaaaaaa-0000-0000-0000-000000000001",
                                           "pathName": "C:\\work\\tower.rvt"}}
EIGHT = ("get_revit_status", "get_revit_model_info", "list_open_documents", "get_selection_snapshot",
         "get_element_properties", "list_levels", "get_current_view_info", "list_category_parameters")


def _template() -> dict:
    return fast_safe_load((Path(profiles.__file__).parent / "config_template.yaml").read_text(encoding="utf-8"))


class TestConfigTemplate:
    def test_revit_server_block(self):
        revit = _template()["mcp_servers"]["revit"]
        assert revit["command"] == "${DEGRAM_PYTHON}"
        assert revit["args"] == ["${DEGRAM_REVIT_MCP_DIR}/main.py"]
        assert revit["env"] == {"DEGRAM_MODE": "1"}
        assert revit["enabled"] is True and revit["connect_timeout"] == 20 and revit["timeout"] == 40
        assert sorted(revit["tools"]["include"]) == sorted(EIGHT)
        assert revit["tools"]["resources"] is False and revit["tools"]["prompts"] is False
        assert revit["sampling"] == {"enabled": False} and revit["elicitation"] == {"enabled": False}

    def test_the_block_has_no_network_transport(self):
        revit = _template()["mcp_servers"]["revit"]
        assert not ({"url", "headers", "auth", "oauth", "transport"} & set(revit))

    def test_tool_include_equals_the_lockdown_names_and_the_adapter_contract(self):
        include = set(_template()["mcp_servers"]["revit"]["tools"]["include"])
        assert {f"mcp__revit__{name}" for name in include} == set(REVIT_TOOL_NAMES)
        contract = Path(__file__).resolve().parents[4] / "apps" / "revit-mcp" / "tests" / "tool_contract.json"
        if contract.is_file():
            assert include == set(json.loads(contract.read_text(encoding="utf-8")))

    def test_the_variant_keeps_the_entry_when_the_placeholders_are_present(self, monkeypatch):
        monkeypatch.setenv("HERMES_DEGRAM", "1")
        from degram_variant.lockdown import lock_mcp_servers
        kept = lock_mcp_servers({"revit": _template()["mcp_servers"]["revit"]})
        assert "revit" in kept and kept["revit"]["sampling"] == {"enabled": False}

    def test_explicit_command_from_settings_still_overrides_the_placeholders(self, tmp_path):
        out = profiles.ensure_scope_profile(tmp_path, ("alice", "acme", "tower"), revit_command="C:\\py\\python.exe",
                                            revit_args=["C:\\r\\main.py"])
        cfg = fast_safe_load((Path(out["path"]) / "config.yaml").read_text(encoding="utf-8"))
        revit = cfg["mcp_servers"]["revit"]
        assert revit["command"] == "C:\\py\\python.exe" and revit["args"] == ["C:\\r\\main.py"]
        assert revit["env"] == {"DEGRAM_MODE": "1"} and revit["tools"]["resources"] is False


@pytest.fixture
def adapter(rt, tmp_path, monkeypatch):
    """The fake Revit adapter registered as MCP server ``revit`` the way the profile config does."""
    from tools import mcp_tool
    from tools.mcp_tool_discovery import register_mcp_servers
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers

    mode_file, calls_file = tmp_path / "mode.json", tmp_path / "calls.jsonl"
    mode_file.write_text(json.dumps({"mode": "ok"}), encoding="utf-8")
    calls_file.write_text("", encoding="utf-8")
    config = {"revit": {
        "command": sys.executable, "args": [str(FAKE_SERVER)], "enabled": True, "connect_timeout": 20, "timeout": 40,
        "env": {"DEGRAM_MODE": "1", "FAKE_REVIT_MODE_FILE": str(mode_file), "FAKE_REVIT_CALLS_FILE": str(calls_file)},
        "tools": {"include": list(EIGHT), "resources": False, "prompts": False}}}
    names = register_mcp_servers(config)
    assert "mcp__revit__list_open_documents" in names, names

    class Adapter:
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


def _group(listing: dict, app: str) -> dict:
    return next(g for g in listing["groups"] if g["app"] == app)


class TestRevitDocuments:
    def test_list_merges_revit_and_gh_rows(self, rt, adapter):
        listing = rt.documents.list()
        assert {g["app"] for g in listing["groups"]} == {"grasshopper", "revit"}
        revit = _group(listing, "revit")
        assert revit["state"] == "ready"
        by_name = {d["name"]: d for d in revit["documents"]}
        tower = by_name["tower.rvt"]
        assert tower["path"] == "C:\\work\\tower.rvt" and tower["unsaved"] is False and tower["isActive"] is True
        assert tower["identity"] == REVIT_PIN["identity"]
        annex = by_name["annex.rvt"]
        assert annex["unsaved"] is True and annex["path"] is None and annex["identity"]["pathName"] == ""
        assert _group(listing, "grasshopper")["documents"][0]["identity"]["documentId"] == GH_DOC_ID
        assert listing["pinned"] == {}, "two open documents, still nothing pinned"

    def test_pin_a_revit_document(self, rt, adapter):
        pinned = rt.documents.pin(**REVIT_PIN)
        assert pinned["app"] == "revit" and pinned["name"] == "tower.rvt"
        assert _group(rt.documents.list(), "revit")["state"] == "pinned"

    def test_adapter_not_connected_is_setup_incomplete(self, rt):
        revit = _group(rt.documents.list(), "revit")
        assert revit["state"] == "setup-incomplete" and revit["code"] == "SETUP_INCOMPLETE"
        assert revit["reason"] == "REVIT_ADAPTER_NOT_CONNECTED"

    @pytest.mark.parametrize("code,reason,state", [
        ("BRIDGE_OFF", None, "off"),
        ("BUSY", None, "busy"),
        ("SETUP_INCOMPLETE", "ROUTES_NOT_LOOPBACK", "setup-incomplete"),
        ("SETUP_INCOMPLETE", "NO_DOCUMENT_OPEN", "setup-incomplete"),
        ("EXTENSION_NOT_LOADED", None, "setup-incomplete"),
        ("ROUTES_DISABLED", None, "setup-incomplete"),
    ])
    def test_adapter_outcomes_map_to_bridge_states_and_keep_the_reason(self, rt, adapter, code, reason, state):
        adapter.mode(mode="error", code=code, **({"reason": reason} if reason else {}))
        group = _group(rt.documents.list(), "revit")
        assert group["state"] == state and group["code"] == code
        assert group.get("reason") == reason
        assert _group(rt.documents.list(), "grasshopper")["state"] == "ready", "the other bridge stays usable"

    def test_a_slow_adapter_is_busy_after_the_deadline_without_retry(self, rt, adapter, monkeypatch):
        monkeypatch.setattr(revit_bridge, "REVIT_DEADLINE_S", 0.6)
        adapter.mode(mode="hang")
        started = time.monotonic()
        group = _group(rt.documents.list(), "revit")
        assert group["state"] == "busy" and group["code"] == "BUSY"
        assert time.monotonic() - started < 5
        assert len([c for c in adapter.calls() if c["tool"] == "list_open_documents"]) == 1, "no retry"


class TestRevitPreviewDeadline:
    """1301-19, G-14: a context preview answers BUSY at REVIT_PREVIEW_DEADLINE_S, below the preview RPC timeout;
    agent tool calls keep REVIT_DEADLINE_S."""

    def test_a_hung_adapter_answers_busy_at_the_preview_deadline_not_the_tool_deadline(self, rt, adapter, monkeypatch):
        from degram_variant import context_composer
        rt.documents.pin(**REVIT_PIN)
        adapter.mode(mode="hang")
        monkeypatch.setattr(revit_bridge, "REVIT_DEADLINE_S", 30.0)  # would fail the test if the preview used it
        monkeypatch.setattr(context_composer, "PREVIEW_BRIDGE_DEADLINE_S", {"revit": 0.6, "grasshopper": 0.6})
        started = time.monotonic()
        view = rt.composer.preview("selection")
        (row,) = view["summary"]["excluded"]
        assert view["status"] == "ok" and row["code"] == "BUSY" and row["bridgeState"] == "busy"
        assert time.monotonic() - started < 10
        assert len([c for c in adapter.calls() if c["tool"] == "get_selection_snapshot"]) == 1, "no retry"

    def test_a_tool_call_still_uses_the_tool_deadline(self, rt, adapter, monkeypatch):
        from degram_variant import context_composer
        adapter.mode(mode="hang")
        monkeypatch.setattr(revit_bridge, "REVIT_DEADLINE_S", 0.6)
        monkeypatch.setattr(context_composer, "PREVIEW_BRIDGE_DEADLINE_S", {"revit": 30.0, "grasshopper": 30.0})
        started = time.monotonic()
        assert _group(rt.documents.list(), "revit")["code"] == "BUSY"
        assert time.monotonic() - started < 10

    def test_read_snapshot_hands_its_deadline_to_the_bounded_run(self, monkeypatch):
        seen = {}

        class _Client:
            def call(self, tool, arguments=None, *, cancel=None, deadline_s=None):
                seen["deadline_s"] = deadline_s
                return {"elements": [], "emptySelection": True}

        source = revit_bridge.RevitDocumentSource(client=_Client())
        source.read_snapshot(REVIT_PIN, "selection", "tower", deadline_s=20.0)
        assert seen["deadline_s"] == 20.0
        source.read_snapshot(REVIT_PIN, "selection", "tower")
        assert seen["deadline_s"] is None, "without a deadline the bounded run keeps REVIT_DEADLINE_S"


class TestRevitSnapshot:
    def test_preview_uses_the_identity_pinned_snapshot_tool(self, rt, adapter):
        rt.documents.pin(**REVIT_PIN)
        view = rt.composer.preview("selection")
        (doc,) = view["summary"]["documents"]
        assert view["status"] == "ok" and doc["objects"] == 2 and doc["parameters"] == 6 and doc["app"] == "revit"
        call = next(c for c in adapter.calls() if c["tool"] == "get_selection_snapshot")
        assert call["arguments"]["identity"] == REVIT_PIN["identity"]
        assert call["arguments"]["max_elements"] == 200 and call["arguments"]["max_parameters"] == 50
        body = json.loads(view["payload"][view["payload"].index("\n{") + 1:])
        assert [e["uniqueId"] for e in body["snapshots"][0]["elements"]] == ["uid-1", "uid-2"]
        assert "tower.rvt" in view["payload"].split("\n{", 1)[0]

    def test_only_the_two_document_tools_are_used_by_the_preview(self, rt, adapter):
        rt.documents.pin(**REVIT_PIN)
        rt.composer.preview("selection")
        assert {c["tool"] for c in adapter.calls()} <= {"list_open_documents", "get_selection_snapshot"}

    @pytest.mark.parametrize("code,reason", [("IDENTITY_MISMATCH", "PATH_DIFFERS"), ("DOCUMENT_NOT_OPEN", None)])
    def test_identity_outcomes_propagate_and_no_data_is_returned(self, rt, adapter, code, reason):
        rt.documents.pin(**REVIT_PIN)
        adapter.mode(mode="error", code=code, **({"reason": reason} if reason else {}))
        view = rt.composer.preview("selection")
        (row,) = view["summary"]["excluded"]
        assert view["status"] == "ok" and row["code"] == code and row["bridgeState"] == "identity-mismatch"
        assert row.get("reason") == reason and view["summary"]["documents"] == []
        assert json.loads(view["payload"][view["payload"].index("\n{") + 1:])["snapshots"] == []

    def test_whole_definition_is_not_supported_for_revit(self, rt, adapter):
        rt.documents.pin(**REVIT_PIN)
        view = rt.composer.preview("whole-definition")
        assert view["status"] == "error" and view["code"] == "SCOPE_NOT_SUPPORTED"
        assert not any(c["tool"] == "get_selection_snapshot" for c in adapter.calls())

    def test_the_client_only_calls_allowlisted_adapter_tools(self, rt, adapter):
        with pytest.raises(BridgeError) as exc:
            revit_bridge.RevitBridgeClient().call("execute_revit_code", {"code": "x"})
        assert exc.value.code == "DEGRAM_LOCKED"
        with pytest.raises(BridgeError):
            revit_bridge.RevitBridgeClient().call("set_parameter", {})
        assert adapter.calls() == []


class TestChildLifecycle:
    def test_the_adapter_runs_in_degram_mode_and_exits_with_the_gateway(self, rt, adapter):
        import psutil
        from tools.mcp_tool_lifecycle import shutdown_mcp_servers

        status = revit_bridge.RevitBridgeClient().call("get_revit_status")
        assert status["degramMode"] == "1", "the child is launched with DEGRAM_MODE=1"
        pid = status["pid"]
        assert psutil.pid_exists(pid)
        shutdown_mcp_servers()
        deadline = time.monotonic() + 10
        while psutil.pid_exists(pid) and time.monotonic() < deadline:
            time.sleep(0.1)
        assert not psutil.pid_exists(pid), "the MCP child must exit when the gateway shuts its servers down"


class TestDegramToolset:
    NAMES = ("degram_project_graph", "degram_list_documents", "degram_document_snapshot", "degram_bridge_status")

    def _call(self, name, args=None):
        from tools.registry import registry
        import tools.degram_tools  # noqa: F401  (registers)
        return json.loads(registry.dispatch(name, args or {}))

    def test_the_toolset_holds_exactly_the_four_tools_and_they_are_allowlisted(self, rt):
        from tools.registry import registry
        import tools.degram_tools  # noqa: F401
        assert sorted(registry.get_tool_names_for_toolset("degram")) == sorted(self.NAMES)
        assert set(self.NAMES) == set(DEGRAM_TOOL_NAMES) and set(self.NAMES) <= set(ALLOWED_TOOL_NAMES)
        from toolsets import TOOLSETS
        assert sorted(TOOLSETS["degram"]["tools"]) == sorted(self.NAMES)

    def test_no_tool_of_the_set_can_write(self, rt):
        from tools.registry import registry
        import tools.degram_tools  # noqa: F401
        verbs = ("create", "set_", "write", "delete", "modify", "execute", "save", "send", "publish", "transform")
        for name in registry.get_tool_names_for_toolset("degram"):
            assert not any(v in name for v in verbs), name
            schema = registry.get_schema(name)
            assert "properties" not in schema.get("parameters", {}) or not (
                {"scope", "project", "host", "url", "port"} & set(schema["parameters"]["properties"])), name

    def test_tools_are_unavailable_outside_variant_degram(self, rt, monkeypatch):
        from tools.registry import registry
        import tools.degram_tools  # noqa: F401
        monkeypatch.delenv("HERMES_DEGRAM")
        for name in self.NAMES:
            assert registry.get_entry(name).check_fn() is False

    def test_list_documents_reads_every_bridge(self, rt, adapter):
        out = self._call("degram_list_documents")
        assert {g["app"] for g in out["groups"]} == {"grasshopper", "revit"} and out["pinned"] == {}

    def test_bridge_status_reports_a_state_per_bridge(self, rt, adapter, gh):
        out = self._call("degram_bridge_status")
        states = {b["app"]: b for b in out["bridges"]}
        assert states["grasshopper"]["state"] == "ready" and states["revit"]["state"] == "ready"
        assert states["revit"]["documents"] == 2 and out["pinned"] == {}

    def test_snapshot_without_a_pinned_document_is_a_named_outcome(self, rt):
        out = self._call("degram_document_snapshot")
        assert out["status"] == "error" and out["code"] == "DOCUMENT_NOT_OPEN" and out["reason"] == "NO_DOCUMENT_PINNED"

    def test_snapshot_reads_only_the_pinned_document_selection(self, rt, gh):
        rt.documents.pin(**GH_PIN)
        out = self._call("degram_document_snapshot")
        assert out["status"] == "ok" and out["scope"] == "selection" and out["summary"]["documents"][0]["objects"] == 2
        assert len(out["snapshots"][0]["nodes"]) == 2
        assert set(gh.commands()) <= {"get_document_identity", "get_selection", "get_canvas_context"}

    def test_snapshot_has_no_scope_argument_so_whole_definition_is_never_a_tool_call(self, rt):
        import tools.degram_tools  # noqa: F401
        from tools.registry import registry
        assert not registry.get_schema("degram_document_snapshot")["parameters"].get("properties")

    def test_snapshot_identity_mismatch_is_reported(self, rt, gh):
        from .fakes import gh_identity
        rt.documents.pin(**GH_PIN)
        gh.handlers["get_document_identity"] = gh_identity(document_id="99999999-0000-0000-0000-000000000000")
        out = self._call("degram_document_snapshot")
        assert out["status"] == "error" and out["code"] == "IDENTITY_MISMATCH"

    def test_project_graph_reads_only_the_bound_project(self, rt, dg):
        out = self._call("degram_project_graph")
        assert out["status"] == "ok" and out["project"] == PROJECT
        assert out["graph"]["nodes"][0]["id"] == "n1" and out["rules"][0]["ruleId"] == "R_URB_HEIGHT_MAX_75_V"
        assert sorted(dg.paths()) == [f"/data-service/graph/{PROJECT}?compact=true", f"/data-service/rules/{PROJECT}"]
        assert all(r["headers"]["Authorization"] == f"Bearer {TOKEN}" for r in dg.requests)

    def test_project_graph_takes_no_project_argument(self, rt):
        import tools.degram_tools  # noqa: F401
        from tools.registry import registry
        assert not registry.get_schema("degram_project_graph")["parameters"].get("properties")

    def test_project_graph_is_bounded_and_discloses_the_cut(self, rt, dg):
        from degram_variant.context_composer import SNAPSHOT_LIMITS
        big = {"nodes": [{"id": f"n{i}", "labels": ["Atom"], "props": {"SWRL_label": "x" * 3000}} for i in range(500)],
               "rels": []}
        dg.routes[f"/data-service/graph/{PROJECT}"] = (200, big)
        out = self._call("degram_project_graph")
        assert out["status"] == "ok" and len(json.dumps(out).encode()) <= SNAPSHOT_LIMITS["max_bytes"] + 4096
        assert any(t["what"] == "nodes" and t["total"] == 500 and t["kept"] < 500 for t in out["truncation"])

    def test_project_graph_backend_failure_is_named(self, rt, dg):
        dg.routes[f"/data-service/graph/{PROJECT}"] = (403, {"detail": "no"})
        out = self._call("degram_project_graph")
        assert out["status"] == "error" and out["code"] == "ACCESS_DENIED"
        dg.routes[f"/data-service/graph/{PROJECT}"] = (500, {"detail": "boom"})
        dg.routes[f"/data-service/rules/{PROJECT}"] = (500, {"detail": "boom"})
        assert self._call("degram_project_graph")["code"] == "DG_UNAVAILABLE"

    def test_rules_are_returned_when_the_graph_is_unavailable(self, rt, dg):
        # Gap G-1: the rules are read on their own; a failed graph read is disclosed, not fatal.
        dg.routes[f"/data-service/graph/{PROJECT}"] = (500, {"detail": "boom"})
        out = self._call("degram_project_graph")
        assert out["status"] == "ok" and out["rules"][0]["ruleId"] == "R_URB_HEIGHT_MAX_75_V"
        assert out["graph"] == {"nodes": [], "rels": []}
        assert {"what": "graph", "reason": "DG_UNAVAILABLE", "detail": "HTTP_500"} in out["missing"]

    def test_rules_are_returned_when_the_graph_answer_is_too_large(self, rt, dg, monkeypatch):
        from degram_variant import dg_client
        from .conftest import RULES
        cap = len(json.dumps(RULES).encode()) + 256  # the rules answer fits, the graph answer does not
        monkeypatch.setattr(dg_client, "MAX_RESPONSE_BYTES", cap)
        big = {"nodes": [{"id": f"n{i}", "labels": ["ValidationEntity"], "props": {}} for i in range(500)], "rels": []}
        dg.routes[f"/data-service/graph/{PROJECT}"] = (200, big)
        out = self._call("degram_project_graph")
        assert out["status"] == "ok" and out["rules"] and out["graph"]["nodes"] == []
        assert {"what": "graph", "reason": "DG_UNAVAILABLE", "detail": "RESPONSE_TOO_LARGE"} in out["missing"]

    def test_rules_failure_alone_keeps_the_graph_and_discloses_it(self, rt, dg):
        dg.routes[f"/data-service/rules/{PROJECT}"] = (500, {"detail": "boom"})
        out = self._call("degram_project_graph")
        assert out["status"] == "ok" and out["graph"]["nodes"][0]["id"] == "n1" and out["rules"] == []
        assert {"what": "rules", "reason": "DG_UNAVAILABLE", "detail": "HTTP_500"} in out["missing"]



class TestProjectGraphFitsTheToolBudget:
    """Gap G-1 (live, 2026-10-07): the agent spills any tool result above its per-result threshold to a file
    and shows the model a 1,500-char preview; DeGram has no file tool, so a spilled graph lost the rules."""

    def _call(self):
        from tools.registry import registry
        import tools.degram_tools  # noqa: F401
        return registry.dispatch("degram_project_graph", {})

    def test_result_stays_under_the_agent_threshold_and_rules_come_first(self, rt, dg):
        from tools.budget_config import DEFAULT_BUDGET
        big = {"nodes": [{"id": f"n{i}", "labels": ["ValidationEntity"], "props": {"x": "y" * 1500}} for i in range(400)],
               "rels": []}
        rules = {"project": PROJECT, "rules": [{"ruleId": f"R_{i}", "text": "t" * 300} for i in range(30)]}
        dg.routes[f"/data-service/graph/{PROJECT}"] = (200, big)
        dg.routes[f"/data-service/rules/{PROJECT}"] = (200, rules)
        raw = self._call()
        assert len(raw) < DEFAULT_BUDGET.resolve_threshold("degram_project_graph")
        out = json.loads(raw)
        assert list(out)[:3] == ["status", "project", "rules"]
        assert [r["ruleId"] for r in out["rules"]] == [f"R_{i}" for i in range(30)]
        assert any(t["what"] == "nodes" and t["kept"] < 400 for t in out["truncation"])

    def test_oversized_rules_are_cut_last_and_disclosed(self, rt, dg):
        from tools.budget_config import DEFAULT_BUDGET
        rules = {"project": PROJECT, "rules": [{"ruleId": f"R_{i}", "text": "t" * 1900} for i in range(200)]}
        dg.routes[f"/data-service/rules/{PROJECT}"] = (200, rules)
        raw = self._call()
        assert len(raw) < DEFAULT_BUDGET.resolve_threshold("degram_project_graph")
        out = json.loads(raw)
        assert out["graph"]["nodes"] == []
        cut = next(t for t in out["truncation"] if t["what"] == "rules")
        assert cut["total"] == 200 and 0 < cut["kept"] == len(out["rules"]) < 200


def _body(view: dict) -> dict:
    return json.loads(view["payload"][view["payload"].index("\n{") + 1:])


def _section(view: dict, app: str) -> dict:
    return next(sec for sec in _body(view)["snapshots"] if sec["app"] == app)


class TestTwoPins:
    """1301-21, G-13, D-29: one pinned document per bridge, both read in one request, a problem on one bridge leaves
    the other usable, nothing is switched or re-pinned automatically."""

    def test_two_pins_coexist_and_pinning_one_bridge_keeps_the_other(self, rt, adapter):
        rt.documents.pin(**GH_PIN)
        rt.documents.pin(**REVIT_PIN)
        assert set(rt.documents.pinned) == {"grasshopper", "revit"}
        assert rt.documents.pinned["grasshopper"]["name"] == "tower.gh"
        assert rt.documents.pinned["revit"]["name"] == "tower.rvt"
        listing = rt.documents.list()
        assert set(listing["pinned"]) == {"grasshopper", "revit"}
        assert _group(listing, "grasshopper")["state"] == "pinned" and _group(listing, "revit")["state"] == "pinned"
        assert [d["pinned"] for d in _group(listing, "revit")["documents"]] == [True, False]
        # a second pin on the same bridge replaces only that bridge's pin
        before = rt.documents.generation
        rt.documents.pin(**GH_PIN)
        assert rt.documents.generation > before and set(rt.documents.pinned) == {"grasshopper", "revit"}

    def test_unpin_one_bridge_leaves_the_other_and_unpin_all_clears_both(self, rt, adapter):
        rt.documents.pin(**GH_PIN)
        rt.documents.pin(**REVIT_PIN)
        rt.documents.unpin("revit")
        assert set(rt.documents.pinned) == {"grasshopper"}
        rt.documents.pin(**REVIT_PIN)
        rt.documents.unpin_all()
        assert rt.documents.pinned == {}

    def test_one_preview_carries_one_snapshot_section_per_document_exactly_as_summarised(self, rt, adapter):
        rt.documents.pin(**GH_PIN)
        rt.documents.pin(**REVIT_PIN)
        view = rt.composer.preview("selection")
        assert view["status"] == "ok" and view["scope"] == "selection" and view["summary"]["excluded"] == []
        by_app = {d["app"]: d for d in view["summary"]["documents"]}
        assert set(by_app) == {"grasshopper", "revit"}
        assert (by_app["grasshopper"]["objects"], by_app["grasshopper"]["parameters"]) == (2, 4)
        assert (by_app["revit"]["objects"], by_app["revit"]["parameters"]) == (2, 6)
        assert [n["instanceId"] for n in _section(view, "grasshopper")["nodes"]] == [
            gh_node(1)["instanceId"], gh_node(2)["instanceId"]]
        assert [e["uniqueId"] for e in _section(view, "revit")["elements"]] == ["uid-1", "uid-2"]
        head = view["payload"].split("\n{", 1)[0]
        assert "tower.gh [grasshopper]" in head and "tower.rvt [revit]" in head
        assert view["summary"]["bytes"] == len(view["payload"].encode("utf-8"))
        # the send embeds the previewed payload byte for byte
        plan = rt.composer.prepare_send(view["previewId"], "Compare the two")
        assert plan.message.startswith(view["payload"])

    def test_a_gh_mismatch_excludes_only_gh_and_revit_is_still_sent(self, rt, adapter, gh):
        from .fakes import gh_identity
        rt.documents.pin(**GH_PIN)
        rt.documents.pin(**REVIT_PIN)
        gh.handlers["get_document_identity"] = gh_identity(document_id="99999999-0000-0000-0000-000000000000")
        view = rt.composer.preview("selection")
        assert view["status"] == "ok" and view["scope"] == "selection"
        assert [d["app"] for d in view["summary"]["documents"]] == ["revit"]
        (row,) = view["summary"]["excluded"]
        assert row["app"] == "grasshopper" and row["code"] == "IDENTITY_MISMATCH" and row["name"] == "tower.gh"
        assert row["bridgeState"] == "identity-mismatch"
        assert [s["app"] for s in _body(view)["snapshots"]] == ["revit"]
        assert _body(view)["excluded"][0]["app"] == "grasshopper"
        assert gh_node(1)["instanceId"] not in view["payload"]
        assert set(rt.documents.pinned) == {"grasshopper", "revit"}, "never unpinned or switched automatically"

    def test_routes_not_loopback_excludes_revit_only(self, rt, adapter):
        rt.documents.pin(**GH_PIN)
        rt.documents.pin(**REVIT_PIN)
        adapter.mode(mode="error", code="SETUP_INCOMPLETE", reason="ROUTES_NOT_LOOPBACK")
        view = rt.composer.preview("selection")
        assert view["status"] == "ok" and [d["app"] for d in view["summary"]["documents"]] == ["grasshopper"]
        (row,) = view["summary"]["excluded"]
        assert row["app"] == "revit" and row["code"] == "SETUP_INCOMPLETE" and row["reason"] == "ROUTES_NOT_LOOPBACK"
        assert row["bridgeState"] == "setup-incomplete"

    def test_a_busy_revit_does_not_stall_gh_and_both_reads_run_concurrently(self, rt, adapter, monkeypatch):
        from degram_variant import context_composer
        rt.documents.pin(**GH_PIN)
        rt.documents.pin(**REVIT_PIN)
        adapter.mode(mode="hang")
        monkeypatch.setattr(context_composer, "PREVIEW_BRIDGE_DEADLINE_S", {"revit": 0.8, "grasshopper": 5.0})
        started = time.monotonic()
        view = rt.composer.preview("selection")
        assert time.monotonic() - started < 8
        assert [d["app"] for d in view["summary"]["documents"]] == ["grasshopper"]
        assert view["summary"]["excluded"][0]["app"] == "revit" and view["summary"]["excluded"][0]["code"] == "BUSY"

    def test_whole_definition_with_both_pins_expands_only_gh(self, rt, adapter):
        rt.documents.pin(**GH_PIN)
        rt.documents.pin(**REVIT_PIN)
        view = rt.composer.preview("whole-definition")
        assert view["status"] == "ok" and view["scope"] == "whole-definition" and view["requiresConsent"] is True
        by_app = {d["app"]: d for d in view["summary"]["documents"]}
        assert by_app["grasshopper"]["objects"] == 5 and len(_section(view, "grasshopper")["nodes"]) == 5
        assert by_app["revit"]["objects"] == 2, "Revit keeps its selection"
        assert "algorithms" in _section(view, "grasshopper") and "algorithms" not in _section(view, "revit")

    def test_whole_definition_with_the_gh_pin_excluded_falls_back_to_the_revit_selection(self, rt, adapter, gh):
        from .fakes import gh_identity
        rt.documents.pin(**GH_PIN)
        rt.documents.pin(**REVIT_PIN)
        gh.handlers["get_document_identity"] = gh_identity(document_id="99999999-0000-0000-0000-000000000000")
        view = rt.composer.preview("whole-definition")
        assert view["status"] == "ok" and view["requestedScope"] == "whole-definition"
        assert view["scope"] == "selection" and view["requiresConsent"] is False
        assert rt.composer.prepare_send(view["previewId"], "hi", scope="whole-definition").consent is False

    def test_whole_definition_without_a_gh_pin_is_not_supported_even_with_revit_pinned(self, rt, adapter):
        rt.documents.pin(**REVIT_PIN)
        view = rt.composer.preview("whole-definition")
        assert view["status"] == "error" and view["code"] == "SCOPE_NOT_SUPPORTED"
        assert view["reason"] == "WHOLE_DEFINITION_GH_ONLY"

    def test_limits_apply_per_document_and_are_disclosed_per_document(self, rt, adapter, gh):
        nodes = [gh_node(i, params=1) for i in range(1, 202)]
        gh.handlers.update(default_gh_handlers(nodes=nodes, selection=[n["instanceId"] for n in nodes]))
        rt.documents.pin(**GH_PIN)
        rt.documents.pin(**REVIT_PIN)
        view = rt.composer.preview("selection")
        by_app = {d["app"]: d for d in view["summary"]["documents"]}
        assert by_app["grasshopper"]["objects"] == 200 and by_app["grasshopper"]["truncated"] is True
        assert by_app["revit"]["objects"] == 2 and by_app["revit"]["truncated"] is False
        assert {"app": "grasshopper", "what": "objects", "kept": 200, "total": 201} in view["truncation"]
        assert not any(t.get("app") == "revit" for t in view["truncation"])

    def test_the_256_kib_cap_covers_the_whole_body(self, rt, adapter, gh):
        from degram_variant.context_composer import SNAPSHOT_LIMITS
        nodes = []
        for i in range(1, 151):
            node = gh_node(i, params=1)
            node["name"] = "x" * 5000
            nodes.append(node)
        gh.handlers.update(default_gh_handlers(nodes=nodes, selection=[n["instanceId"] for n in nodes]))
        rt.documents.pin(**GH_PIN)
        rt.documents.pin(**REVIT_PIN)
        view = rt.composer.preview("selection")
        assert view["summary"]["bytes"] <= SNAPSHOT_LIMITS["max_bytes"]
        assert len(view["payload"].encode("utf-8")) == view["summary"]["bytes"]
        by_app = {d["app"]: d for d in view["summary"]["documents"]}
        assert 0 < by_app["grasshopper"]["objects"] < 150 and by_app["grasshopper"]["truncated"] is True
        assert by_app["revit"]["objects"] == 2
        assert any(t["what"] == "bytes" for t in view["truncation"])

    def test_a_preview_goes_stale_after_a_re_pin_of_either_bridge(self, rt, adapter):
        from degram_variant.context_composer import ContextError
        rt.documents.pin(**GH_PIN)
        rt.documents.pin(**REVIT_PIN)
        for app_pin in (GH_PIN, REVIT_PIN):
            view = rt.composer.preview("selection")
            rt.documents.pin(**app_pin)
            with pytest.raises(ContextError) as exc:
                rt.composer.prepare_send(view["previewId"], "hi")
            assert exc.value.code == "PREVIEW_STALE"

    def test_a_scope_reset_clears_both_pins(self, rt, adapter):
        from degram_variant import runtime
        rt.documents.pin(**GH_PIN)
        rt.documents.pin(**REVIT_PIN)
        view = rt.composer.preview("selection")
        runtime.reset_scope()
        assert rt.documents.pinned == {}
        from degram_variant.context_composer import ContextError
        with pytest.raises(ContextError):
            rt.composer.prepare_send(view["previewId"], "hi")

    def test_the_agent_tool_reads_both_pinned_documents_and_names_an_excluded_one(self, rt, adapter, gh):
        from .fakes import gh_identity
        rt.documents.pin(**GH_PIN)
        rt.documents.pin(**REVIT_PIN)
        out = TestDegramToolset()._call("degram_document_snapshot")
        assert out["status"] == "ok" and {s["app"] for s in out["snapshots"]} == {"grasshopper", "revit"}
        assert out["excluded"] == [] and {d["app"] for d in out["documents"]} == {"grasshopper", "revit"}
        gh.handlers["get_document_identity"] = gh_identity(document_id="99999999-0000-0000-0000-000000000000")
        out = TestDegramToolset()._call("degram_document_snapshot")
        assert out["status"] == "ok" and [s["app"] for s in out["snapshots"]] == ["revit"]
        assert out["excluded"][0]["app"] == "grasshopper" and out["excluded"][0]["code"] == "IDENTITY_MISMATCH"

    def test_the_tool_descriptions_name_both_pinned_documents(self, rt):
        import tools.degram_tools  # noqa: F401
        from tools.registry import registry
        for name in ("degram_list_documents", "degram_document_snapshot"):
            assert "Revit model and/or Grasshopper definition" in registry.get_schema(name)["description"]
