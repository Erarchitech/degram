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

from .conftest import GH_PIN, PROJECT, TOKEN
from .fakes import GH_DOC_ID

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
        assert listing["pinned"] is None, "two open documents, still nothing pinned"

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


class TestRevitSnapshot:
    def test_preview_uses_the_identity_pinned_snapshot_tool(self, rt, adapter):
        rt.documents.pin(**REVIT_PIN)
        view = rt.composer.preview("selection")
        assert view["status"] == "ok" and view["summary"]["objects"] == 2 and view["summary"]["parameters"] == 6
        call = next(c for c in adapter.calls() if c["tool"] == "get_selection_snapshot")
        assert call["arguments"]["identity"] == REVIT_PIN["identity"]
        assert call["arguments"]["max_elements"] == 200 and call["arguments"]["max_parameters"] == 50
        body = json.loads(view["payload"][view["payload"].index("\n{") + 1:])
        assert [e["uniqueId"] for e in body["snapshot"]["elements"]] == ["uid-1", "uid-2"]
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
        assert view["status"] == "error" and view["code"] == code and view["bridgeState"] == "identity-mismatch"
        assert view.get("reason") == reason and "payload" not in view

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
        assert {g["app"] for g in out["groups"]} == {"grasshopper", "revit"} and out["pinned"] is None

    def test_bridge_status_reports_a_state_per_bridge(self, rt, adapter, gh):
        out = self._call("degram_bridge_status")
        states = {b["app"]: b for b in out["bridges"]}
        assert states["grasshopper"]["state"] == "ready" and states["revit"]["state"] == "ready"
        assert states["revit"]["documents"] == 2 and out["pinned"] is None

    def test_snapshot_without_a_pinned_document_is_a_named_outcome(self, rt):
        out = self._call("degram_document_snapshot")
        assert out["status"] == "error" and out["code"] == "DOCUMENT_NOT_OPEN" and out["reason"] == "NO_DOCUMENT_PINNED"

    def test_snapshot_reads_only_the_pinned_document_selection(self, rt, gh):
        rt.documents.pin(**GH_PIN)
        out = self._call("degram_document_snapshot")
        assert out["status"] == "ok" and out["scope"] == "selection" and out["summary"]["objects"] == 2
        assert len(out["snapshot"]["nodes"]) == 2
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
        assert sorted(dg.paths()) == [f"/data-service/graph/{PROJECT}", f"/data-service/rules/{PROJECT}"]
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
        assert self._call("degram_project_graph")["code"] == "DG_UNAVAILABLE"
