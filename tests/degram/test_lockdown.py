"""Variant degram lockdown (plan 1301-10 task 2, D-16/D-22/DGCL-02/D-03).

The surface is proven closed in code, not by hiding schemas:

* the tool REGISTRY itself holds only the allowlist (subprocess, so import-time registration of the
  stock tools is observed from a clean interpreter);
* provider/model selection RPCs, config keys, slash commands and REST routes answer DEGRAM_LOCKED;
* every auxiliary task resolves to the pinned relay route or is disabled, whatever config says;
* a socket guard sees no host other than loopback (the fake relay) during dashboard startup,
  gateway/MCP startup and one turn.
"""

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

import tui_gateway.server as server
from degram_variant import lockdown
from degram_variant.lockdown import (
    ALLOWED_RPC_METHODS,
    ALLOWED_TOOL_NAMES,
    DEGRAM_TOOL_NAMES,
    DegramLockedError,
    assert_rpc_allowed,
    is_degram,
)

REPO = Path(__file__).resolve().parents[2]
TOKEN = "dgd_lockdown_token"

FORBIDDEN_TOOL_NAMES = {
    "terminal", "process", "execute_code", "read_file", "write_file", "patch", "search_files",
    "web_search", "web_extract", "browser_navigate", "browser_exec", "vision_analyze", "image_generate",
    "text_to_speech", "skill_manage", "skill_view", "skills_list", "memory", "session_search",
    "delegate_task", "cronjob", "computer_use", "tool_search", "tool_describe", "tool_call",
}


def run_py(code: str, tmp_path: Path, *, degram: bool, extra_env: dict | None = None, timeout: int = 240) -> dict:
    """Run ``code`` in a clean interpreter against a fresh HERMES_HOME; its LAST stdout line is JSON."""
    home = tmp_path / ("home-degram" if degram else "home-stock")
    home.mkdir(exist_ok=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith("HERMES_")}
    env.update({"HERMES_HOME": str(home), "HERMES_TEST_ISOLATION": "1", "PYTHONPATH": str(REPO), "PYTHONUTF8": "1"})
    if degram:
        env["HERMES_DEGRAM"] = "1"
    env.update(extra_env or {})
    proc = subprocess.run([sys.executable, "-c", textwrap.dedent(code)], cwd=str(REPO), env=env,
                          capture_output=True, text=True, timeout=timeout)
    # importing the gateway server redirects sys.stdout to stderr (stdout is the JSON-RPC channel)
    lines = [ln for ln in (proc.stdout + chr(10) + proc.stderr).splitlines() if ln.startswith("RESULT::")]
    assert lines, f"no RESULT on stdout (rc={proc.returncode})\nSTDERR:\n{proc.stderr[-3000:]}\nSTDOUT:\n{proc.stdout[-1500:]}"
    return json.loads(lines[-1][len("RESULT::"):])


@pytest.fixture
def degram(monkeypatch):
    monkeypatch.setenv("HERMES_DEGRAM", "1")
    from degram_variant.credentials import credentials
    credentials.clear()
    yield
    credentials.clear()


def rpc(method, params=None, rid=1):
    return server.handle_request({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})


def locked_code(resp) -> str | None:
    return ((resp or {}).get("error") or {}).get("data", {}).get("code") if isinstance((resp or {}).get("error"), dict) else None


# ── allowlist contents ───────────────────────────────────────────────────────────────────────


class TestAllowlistContents:
    def test_exact_tool_allowlist(self):
        assert ALLOWED_TOOL_NAMES == frozenset({
            "clarify", "todo_list",
            "degram_project_graph", "degram_document_snapshot", "degram_list_documents", "degram_bridge_status",
            "mcp__revit__get_revit_status", "mcp__revit__get_revit_model_info", "mcp__revit__list_open_documents",
            "mcp__revit__get_selection_snapshot", "mcp__revit__get_element_properties", "mcp__revit__list_levels",
            "mcp__revit__get_current_view_info", "mcp__revit__list_category_parameters"})

    def test_forbidden_names_are_not_allowlisted(self):
        assert FORBIDDEN_TOOL_NAMES.isdisjoint(ALLOWED_TOOL_NAMES)
        assert not any(n.startswith(("browser_", "kanban_", "desktop_", "cron")) for n in ALLOWED_TOOL_NAMES)


# ── registry ─────────────────────────────────────────────────────────────────────────────────

REGISTRY_SCRIPT = """
    import json
    import model_tools  # the module the agent imports; it drives discover_builtin_tools()
    from tools.registry import registry
    try:
        import tools.mcp_tool  # registers MCP tooling hooks, if any
    except Exception:
        pass
    print("RESULT::" + json.dumps(sorted(registry.get_all_tool_names())))
"""


class TestRegistry:
    def test_stock_registry_registers_the_forbidden_tools(self, tmp_path):
        """Control: without the variant the very same script registers them, so the next test discriminates."""
        names = set(run_py(REGISTRY_SCRIPT, tmp_path, degram=False))
        assert {"terminal", "read_file", "web_search", "execute_code"} <= names

    def test_degram_registry_holds_only_the_allowlist(self, tmp_path):
        names = set(run_py(REGISTRY_SCRIPT, tmp_path, degram=True))
        assert names <= ALLOWED_TOOL_NAMES, f"registered outside the allowlist: {sorted(names - ALLOWED_TOOL_NAMES)}"
        assert {"clarify", "todo_list"} <= names
        assert DEGRAM_TOOL_NAMES <= names, "plan 1301-11 registers the degram toolset"
        assert FORBIDDEN_TOOL_NAMES.isdisjoint(names)

    def test_register_refuses_any_name_outside_the_allowlist(self, degram):
        from tools.registry import ToolRegistry
        reg = ToolRegistry()
        schema = {"name": "x", "description": "d", "parameters": {"type": "object", "properties": {}}}
        for name in ("terminal", "mcp__revit__not_allowlisted", "mcp_other_get_status", "send_message"):
            reg.register(name=name, toolset="t", schema=schema, handler=lambda a, **k: "{}")
        assert reg.get_all_tool_names() == []
        reg.register(name="mcp__revit__get_revit_status", toolset="mcp-revit", schema=schema, handler=lambda a, **k: "{}")
        reg.register(name="clarify", toolset="clarify", schema=schema, handler=lambda a, **k: "{}")
        assert sorted(reg.get_all_tool_names()) == ["clarify", "mcp__revit__get_revit_status"]

    def test_register_is_unchanged_outside_degram(self, monkeypatch):
        monkeypatch.delenv("HERMES_DEGRAM", raising=False)
        from tools.registry import ToolRegistry
        reg = ToolRegistry()
        schema = {"name": "x", "description": "d", "parameters": {"type": "object", "properties": {}}}
        reg.register(name="terminal", toolset="terminal", schema=schema, handler=lambda a, **k: "{}")
        assert reg.get_all_tool_names() == ["terminal"]


# ── toolset assembly ─────────────────────────────────────────────────────────────────────────


class TestToolsetAssembly:
    @pytest.mark.parametrize("platform", [None, "desktop", "tui", "cli"])
    def test_selection_is_the_fixed_degram_set(self, degram, platform):
        enabled = server._load_enabled_toolsets(platform)
        assert enabled is not None
        assert set(enabled) == {"clarify", "todo", "degram", "mcp-revit"}
        assert "desktop_ui" not in enabled and "project" not in enabled

    def test_coding_posture_and_operator_pins_cannot_widen_it(self, degram, monkeypatch, tmp_path):
        (tmp_path / ".git").mkdir()
        (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n", encoding="utf-8")
        monkeypatch.chdir(tmp_path)
        monkeypatch.setenv("HERMES_TUI_TOOLSETS", "terminal,web,file,all")
        monkeypatch.setenv("TERMINAL_CWD", str(tmp_path))
        assert set(server._load_enabled_toolsets("desktop")) == {"clarify", "todo", "degram", "mcp-revit"}

    def test_stock_selection_is_untouched(self, monkeypatch):
        monkeypatch.delenv("HERMES_DEGRAM", raising=False)
        monkeypatch.delenv("HERMES_TUI_TOOLSETS", raising=False)
        enabled = server._load_enabled_toolsets("desktop")
        assert enabled is None or "desktop_ui" in enabled


# ── agent assembled by the gateway ───────────────────────────────────────────────────────────


class TestAssembledAgent:
    def test_agent_holds_only_allowlisted_tools_and_no_side_channels(self, degram, tmp_path):
        script = """
            import json, time
            from degram_variant.credentials import credentials
            credentials.set(token="dgd_t", expires_at=time.time() + 600, relay_base_url="http://127.0.0.1:9/data-service",
                            user="u", company=None, project="p")
            import tui_gateway.server as server
            agent = server._make_agent("sid", "key", platform_override="desktop")
            print("RESULT::" + json.dumps({
                "tools": sorted(t["function"]["name"] for t in (agent.tools or [])),
                "valid": sorted(getattr(agent, "valid_tool_names", []) or []),
                "skip_memory": bool(getattr(agent, "skip_memory", False)),
                "memory": getattr(agent, "_memory_manager", None) is not None,
                "fallback": list(getattr(agent, "_fallback_chain", []) or []),
                "pool": getattr(agent, "_credential_pool", None) is not None,
            }))
        """
        out = run_py(script, tmp_path, degram=True)
        assert set(out["tools"]) <= ALLOWED_TOOL_NAMES, sorted(set(out["tools"]) - ALLOWED_TOOL_NAMES)
        assert set(out["valid"]) <= ALLOWED_TOOL_NAMES
        assert {"clarify", "todo_list"} <= set(out["tools"]), out["tools"]  # directly visible, no tool_search bridge
        assert out["fallback"] == [] and out["pool"] is False
        assert out["memory"] is False


# ── auxiliary routes ─────────────────────────────────────────────────────────────────────────

AUX_TASKS_DISABLED = [
    "title_generation", "vision", "curator", "background_review", "skills_hub", "approval", "mcp",
    "memory_query_rewrite", "tts_audio_tags", "triage_specifier", "kanban_decomposer", "profile_describer",
    "goal_judge", "monitor", "moa_reference", "moa_aggregator", "review", "session_search", "",
]


def _hostile_config(home: Path) -> None:
    lines = ["auxiliary:"]
    for task in ["compression", "title_generation", "vision", "curator", "background_review", "mcp", "approval"]:
        lines += [f"  {task}:", "    provider: openrouter", "    model: x/evil", "    base_url: http://evil.example/v1",
                  "    api_key: sk-evil"]
    lines += ["fallback_providers:", "  - provider: openrouter", "    model: x/y", ""]
    (home / "config.yaml").write_text("\n".join(lines), encoding="utf-8")


class TestAuxiliaryRoutes:
    def _client_hosts(self, client):
        return str(getattr(client, "base_url", ""))

    def test_compression_resolves_to_the_relay_even_with_hostile_config(self, degram, tmp_path):
        script = """
            import json, os, time
            from pathlib import Path
            home = Path(os.environ["HERMES_HOME"])
            lines = ["auxiliary:"]
            for task in ["compression", "title_generation", "vision", "curator", "background_review", "mcp", "approval"]:
                lines += ["  " + task + ":", "    provider: openrouter", "    model: x/evil",
                          "    base_url: http://evil.example/v1", "    api_key: sk-evil"]
            lines += ["fallback_providers:", "  - provider: openrouter", "    model: x/y", ""]
            (home / "config.yaml").write_text("\\n".join(lines), encoding="utf-8")
            from degram_variant.credentials import credentials
            from degram_variant.provider import pinned_runtime
            credentials.set(token="dgd_t", expires_at=time.time() + 600, relay_base_url="http://127.0.0.1:9/data-service",
                            user="u", company=None, project="p")
            runtime = pinned_runtime()
            main_runtime = {"provider": runtime["provider"], "model": "degram-system", "base_url": runtime["base_url"],
                            "api_key": runtime["api_key"], "api_mode": runtime["api_mode"]}
            from agent import auxiliary_client as aux
            result = {}
            for task in ["compression", "title_generation", "vision", "curator", "background_review", "mcp",
                         "approval", "skills_hub", "session_search", "memory_query_rewrite", ""]:
                client, model = aux.resolve_provider_client("auto", None, main_runtime=main_runtime, task=task or None)
                result[task or "<none>"] = None if client is None else str(client.base_url)
            print("RESULT::" + json.dumps({"routes": result, "discovery": aux._discovery_chain_allowed("", "compression")}))
        """
        out = run_py(script, tmp_path, degram=True)
        assert out["discovery"] is False
        relay = "http://127.0.0.1:9/data-service/degram/v1"
        for task, base in out["routes"].items():
            assert base is None or base.rstrip("/") == relay, f"{task} resolved to {base}"
        assert out["routes"]["compression"] is not None, "compression must stay available on the pinned route"
        for task in ("title_generation", "vision", "curator", "background_review", "mcp", "approval", "skills_hub",
                     "session_search", "memory_query_rewrite", "<none>"):
            assert out["routes"][task] is None, f"auxiliary task {task!r} must be disabled in variant degram"

    def test_fallback_and_discovery_chains_are_closed(self, degram, monkeypatch):
        from agent import auxiliary_client as aux
        assert aux._discovery_chain_allowed("", "compression") is False
        assert aux._discovery_chain_allowed("auto", None) is False
        assert aux._try_discovery_chain() == (None, None, "")
        assert aux._try_main_fallback_chain("compression", "auto", reason="x") == (None, None, "")

    def test_stock_discovery_gate_is_untouched(self, monkeypatch):
        monkeypatch.delenv("HERMES_DEGRAM", raising=False)
        from agent import auxiliary_client as aux
        assert aux._discovery_chain_allowed("", "compression") is True


# ── RPC lock ─────────────────────────────────────────────────────────────────────────────────

LOCKED_RPCS = [
    "model.options", "model.save_key", "model.disconnect", "shell.exec", "cli.exec", "process.list", "process.kill",
    "mcp.servers.add", "mcp.servers.remove", "mcp.servers.set_api_key", "mcp.servers.test", "mcp.catalog",
    "plugins.manage", "skills.manage", "cron.manage", "tools.configure", "connectors.connect", "connectors.list",
    "image.generate", "llm.oneshot", "billing.charge", "subscription.upgrade", "free_tier.provision",
    "file.attach", "image.attach", "complete.path", "session.cwd.set", "session.workspace.move",
    "delegation.pause", "subagent.steer", "browser.manage", "vault.unlock", "reload.mcp", "reload.env",
    "profiles.create", "projects.add_folder", "groups.create", "display.start", "voice.record", "wake.start",
    "rollback.restore", "pet.generate", "bot_relay.deliver", "onboarding.reset_setup_profile",
]
LOCKED_CONFIG_KEYS = [
    "model", "provider", "providers", "providers.x.base_url", "custom_providers", "fallback_providers",
    "fallback_model", "fallback.min_switch_reset_seconds", "toolsets", "platform_toolsets", "platform_toolsets.cli",
    "mcp_servers", "mcp_servers.revit.command", "mcp.sampling", "auxiliary", "auxiliary.compression.provider",
    "auxiliary.title_generation.base_url", "cwd", "terminal.cwd", "workdir", "prompt", "personality", "yolo",
    "approval_mode", "approvals.mode",
]


class TestRpcLock:
    def test_every_registered_method_is_classified(self, degram):
        registered = set(server._methods)
        assert ALLOWED_RPC_METHODS <= registered | {"degram.credentials.set"}, (
            "an allowlisted RPC no longer exists: " + str(sorted(ALLOWED_RPC_METHODS - registered)))
        for name in registered:
            if name in ALLOWED_RPC_METHODS:
                continue
            with pytest.raises(DegramLockedError):
                assert_rpc_allowed(name, {})

    def test_allowlist_excludes_the_dangerous_families(self):
        for name in LOCKED_RPCS:
            assert name not in ALLOWED_RPC_METHODS, name
        for prefix in ("model.", "mcp.", "plugins.", "skills.", "cron.", "connectors.", "billing.", "subscription.",
                       "image.", "file.", "shell.", "cli.", "process.", "delegation.", "subagent.", "groups.",
                       "vault.", "browser.", "wake.", "voice.", "pet.", "projects.", "profiles.", "display.",
                       "rollback.", "reload.", "bot_relay.", "onboarding."):
            assert not [n for n in ALLOWED_RPC_METHODS if n.startswith(prefix) and n not in
                        {"profiles.list", "projects.list", "projects.get"}], prefix

    @pytest.mark.parametrize("method", LOCKED_RPCS)
    def test_locked_methods_answer_degram_locked_without_running_the_handler(self, degram, monkeypatch, method):
        called = []
        monkeypatch.setitem(server._methods, method, lambda rid, params: called.append(method) or {"id": rid, "error": {"code": 1, "message": "stub"}})
        resp = rpc(method)
        assert locked_code(resp) == "DEGRAM_LOCKED", resp
        assert called == []

    @pytest.mark.parametrize("key", LOCKED_CONFIG_KEYS)
    def test_config_set_on_provider_model_toolset_mcp_keys_is_locked(self, degram, key):
        resp = rpc("config.set", {"key": key, "value": "x"})
        assert locked_code(resp) == "DEGRAM_LOCKED", resp

    def test_config_set_on_a_display_key_reaches_the_handler(self, degram, monkeypatch):
        reached = []
        monkeypatch.setitem(server._methods, "config.set", lambda rid, params: reached.append(params["key"]) or {"id": rid, "error": {"code": 1, "message": "stub"}})
        rpc("config.set", {"key": "theme", "value": "dark"})
        assert reached == ["theme"]

    @pytest.mark.parametrize("command", ["/model", "/model gpt-5", "  /MODEL x", "/fallback add openrouter",
                                        "/provider", "/tools enable terminal", "/skills install x", "/cron add",
                                        "/reload-mcp", "/plugins install x", "/yolo", "/terminal"])
    @pytest.mark.parametrize("method", ["slash.exec", "command.dispatch", "command.resolve"])
    def test_provider_and_tool_slash_commands_are_locked(self, degram, monkeypatch, method, command):
        called = []
        monkeypatch.setitem(server._methods, method, lambda rid, params: called.append(1) or {"id": rid, "error": {"code": 1, "message": "stub"}})
        key = "command" if method != "slash.exec" else "command"
        resp = rpc(method, {key: command, "name": command.strip().lstrip("/").split()[0], "arg": ""})
        assert locked_code(resp) == "DEGRAM_LOCKED", resp
        assert called == []

    def test_harmless_slash_command_reaches_the_handler(self, degram, monkeypatch):
        called = []
        monkeypatch.setitem(server._methods, "slash.exec", lambda rid, params: called.append(1) or {"id": rid, "error": {"code": 1, "message": "stub"}})
        rpc("slash.exec", {"command": "/help", "session_id": "s"})
        assert called == [1]

    def test_stock_gateway_is_untouched(self, monkeypatch):
        monkeypatch.delenv("HERMES_DEGRAM", raising=False)
        called = []
        monkeypatch.setitem(server._methods, "model.options", lambda rid, params: called.append(1) or {"id": rid, "error": {"code": 1, "message": "stub"}})
        resp = rpc("model.options")
        assert locked_code(resp) != "DEGRAM_LOCKED" and called == [1]
        assert_rpc_allowed("shell.exec", {})  # no-op outside degram


# ── REST lock ────────────────────────────────────────────────────────────────────────────────

REST_SCRIPT = """
    import json
    from fastapi.routing import APIRoute, APIWebSocketRoute
    from starlette.testclient import TestClient
    import hermes_cli.web_server as ws
    api = sorted({r.path for r in ws.app.router.routes if getattr(r, "path", "").startswith("/api/")})
    ws_routes = sorted({r.path for r in ws.app.router.routes if isinstance(r, APIWebSocketRoute)})
    client = TestClient(ws.app, base_url="http://127.0.0.1")
    headers = {ws._SESSION_HEADER_NAME: ws._SESSION_TOKEN}
    probes = {}
    for method, path in [("GET", "/api/providers"), ("GET", "/api/providers/openrouter"), ("PUT", "/api/env"),
                         ("GET", "/api/config"), ("GET", "/api/skills"), ("GET", "/api/health"),
                         ("GET", "/api/status"), ("POST", "/api/model/set")]:
        r = client.request(method, path, headers=headers, json={} if method != "GET" else None)
        try:
            body = r.json()
        except Exception:
            body = {}
        detail = body.get("detail") if isinstance(body, dict) else None
        probes[method + " " + path] = [r.status_code, detail.get("code") if isinstance(detail, dict) else None]
    print("RESULT::" + json.dumps({"api": api, "ws": ws_routes, "probes": probes}))
"""


class TestRestLock:
    def test_degram_dashboard_keeps_only_the_gateway_and_liveness_routes(self, tmp_path):
        out = run_py(REST_SCRIPT, tmp_path, degram=True, extra_env={"HERMES_DASHBOARD_SESSION_TOKEN": "t" * 24})
        allowed_paths = {"/api/ws", "/api/health", "/api/status", "/api/{rest_of_path:path}"}
        assert set(out["api"]) <= allowed_paths, sorted(set(out["api"]) - allowed_paths)
        assert out["ws"] == ["/api/ws"]
        for key in ("GET /api/providers", "GET /api/providers/openrouter", "PUT /api/env", "GET /api/config",
                    "GET /api/skills", "POST /api/model/set"):
            status, code = out["probes"][key]
            assert (status, code) == (403, "DEGRAM_LOCKED"), (key, out["probes"][key])
        assert out["probes"]["GET /api/health"][0] == 200

    def test_stock_dashboard_keeps_its_providers_route(self, tmp_path):
        out = run_py(REST_SCRIPT, tmp_path, degram=False, extra_env={"HERMES_DASHBOARD_SESSION_TOKEN": "t" * 24})
        assert "/api/providers" in " ".join(out["api"]) or any(p.startswith("/api/model") for p in out["api"])
        assert len(out["api"]) > 50 and len(out["ws"]) > 1


# ── configuration lock ───────────────────────────────────────────────────────────────────────

CONFIG_SCRIPT = """
    import json, os
    from pathlib import Path
    home = Path(os.environ["HERMES_HOME"])
    (home / "config.yaml").write_text(
        "model:\\n  provider: openrouter\\n  default: x/evil\\n  base_url: http://evil.example/v1\\n"
        "fallback_providers:\\n  - provider: openrouter\\n    model: x/y\\n"
        "providers:\\n  evil:\\n    base_url: http://evil.example/v1\\n"
        "toolsets: [hermes-cli]\\nplatform_toolsets:\\n  cli: [terminal, web]\\n"
        "mcp_servers:\\n  revit:\\n    command: revit-mcp\\n    sampling:\\n      enabled: true\\n"
        "  evil:\\n    command: npx\\n    args: [-y, evil-pkg]\\n"
        "  remote:\\n    url: http://evil.example/mcp\\n"
        "model_catalog:\\n  enabled: true\\ntelemetry:\\n  shared_metrics:\\n    enabled: true\\n    send: true\\n"
        "updates:\\n  check: true\\nnous:\\n  guest: true\\ncurator:\\n  enabled: true\\n"
        "plugins:\\n  auto_update_check_hours: 24\\n  auto_apply: true\\n"
        "memory:\\n  memory_enabled: true\\n  provider: mem0\\n"
        "auxiliary:\\n  compression:\\n    provider: openrouter\\n    base_url: http://evil.example/v1\\n    api_key: sk-evil\\n"
        "  title_generation:\\n    provider: openrouter\\n    model_upgrade_enabled: true\\n"
        "  background_review:\\n    enabled: true\\n", encoding="utf-8")
    from hermes_cli.config import load_config
    cfg = load_config()
    print("RESULT::" + json.dumps(cfg))
"""


class TestConfigLock:
    def test_locked_values_win_over_the_config_file(self, tmp_path):
        cfg = run_py(CONFIG_SCRIPT, tmp_path, degram=True)
        assert cfg["model"]["provider"] == "custom" and cfg["model"]["default"] == "degram-system"
        assert not cfg["model"].get("base_url")
        assert cfg["fallback_providers"] == [] and not cfg.get("fallback_model")
        assert cfg["providers"] == {} and not cfg.get("custom_providers")
        assert set(cfg["mcp_servers"]) == {"revit"}, cfg["mcp_servers"]
        assert cfg["mcp_servers"]["revit"]["sampling"]["enabled"] is False
        assert "url" not in cfg["mcp_servers"]["revit"]
        assert cfg["tools"]["tool_search"]["enabled"] == "off"
        assert cfg["model_catalog"]["enabled"] is False
        assert cfg["telemetry"]["shared_metrics"] == {**cfg["telemetry"]["shared_metrics"], "enabled": False, "send": False}
        assert cfg["updates"]["check"] is False
        assert cfg["nous"]["guest"] is False
        assert cfg["curator"]["enabled"] is False
        assert cfg["plugins"]["auto_update_check_hours"] == 0 and cfg["plugins"]["auto_apply"] is False
        assert cfg["memory"]["memory_enabled"] is False and cfg["memory"]["user_profile_enabled"] is False
        assert not cfg["memory"].get("provider")
        for task, block in cfg["auxiliary"].items():
            if not isinstance(block, dict):
                continue  # scalar settings (e.g. max_concurrency) live beside the task blocks
            assert block.get("provider", "auto") == "auto", task
            assert not block.get("base_url") and not block.get("api_key"), task
        assert cfg["auxiliary"]["title_generation"]["model_upgrade_enabled"] is False
        assert cfg["auxiliary"]["background_review"]["enabled"] is False
        assert set(cfg["platform_toolsets"]["cli"]) == {"clarify", "todo", "degram", "mcp-revit"}
        assert set(cfg["toolsets"]) == {"clarify", "todo", "degram", "mcp-revit"}

    def test_stock_config_is_untouched(self, tmp_path):
        cfg = run_py(CONFIG_SCRIPT, tmp_path, degram=False)
        assert cfg["model"]["provider"] == "openrouter" and cfg["fallback_providers"]
        assert cfg["model_catalog"]["enabled"] is True and cfg["updates"]["check"] is True
        assert "evil" in cfg["mcp_servers"]


# ── network kill switches ────────────────────────────────────────────────────────────────────


class TestKillSwitches:
    def test_context_length_is_fixed_and_metadata_probes_are_refused(self, degram):
        from agent.model_metadata import get_model_context_length
        from agent.model_metadata_http import get as metadata_get
        assert get_model_context_length("degram-system", "http://127.0.0.1:1/data-service/degram/v1") == \
            lockdown.DEGRAM_DEFAULT_CONTEXT_LENGTH
        with pytest.raises(ConnectionError):
            metadata_get("http://127.0.0.1:1/models")

    def test_osv_preflight_is_skipped_only_in_degram(self, monkeypatch):
        import asyncio
        import tools.osv_check as osv
        from tools import mcp_tool
        calls = []
        monkeypatch.setattr(osv, "check_package_for_malware", lambda command, args: calls.append(command) or None)
        monkeypatch.setenv("HERMES_DEGRAM", "1")
        asyncio.run(mcp_tool._preflight_stdio_command("revit", "npx", ["-y", "pkg"]))
        assert calls == []
        monkeypatch.delenv("HERMES_DEGRAM")
        asyncio.run(mcp_tool._preflight_stdio_command("revit", "npx", ["-y", "pkg"]))
        assert calls == ["npx"]

    def test_mcp_sampling_is_forced_off_for_every_server(self, degram):
        cfg = lockdown.lock_mcp_server_config({"command": "revit-mcp", "sampling": {"enabled": True}, "url": "http://x"})
        assert cfg["sampling"]["enabled"] is False and "url" not in cfg


# ── socket guard ─────────────────────────────────────────────────────────────────────────────

SOCKET_SCRIPT = """
    import json, os, socket, sys, threading, time
    sys.path.insert(0, os.getcwd())
    attempts = []
    LOOP = {"127.0.0.1", "localhost", "::1", "0.0.0.0", ""}

    def host_of(addr):
        return addr[0] if isinstance(addr, (tuple, list)) and addr else str(addr)

    _create, _gai, _connect, _connect_ex = socket.create_connection, socket.getaddrinfo, socket.socket.connect, socket.socket.connect_ex

    def create_connection(address, *a, **kw):
        attempts.append(host_of(address));
        if host_of(address) not in LOOP:
            raise OSError("blocked by degram socket guard: " + host_of(address))
        return _create(address, *a, **kw)

    def getaddrinfo(host, *a, **kw):
        h = host.decode() if isinstance(host, bytes) else host
        attempts.append(str(h))
        if str(h) not in LOOP:
            raise socket.gaierror("blocked by degram socket guard: " + str(h))
        return _gai(host, *a, **kw)

    def connect(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6):
            attempts.append(host_of(address))
            if host_of(address) not in LOOP:
                raise OSError("blocked by degram socket guard: " + host_of(address))
        return _connect(self, address)

    socket.create_connection, socket.getaddrinfo, socket.socket.connect = create_connection, getaddrinfo, connect

    from tests.degram.test_credentials_provider import FakeRelay
    relay = FakeRelay()
    from degram_variant.credentials import credentials
    credentials.set(token="dgd_t", expires_at=time.time() + 600, relay_base_url=relay.base, user="u", company=None, project="p")

    # 1. dashboard startup: import + lifespan startup events
    from starlette.testclient import TestClient
    import hermes_cli.web_server as ws
    with TestClient(ws.app, base_url="http://127.0.0.1") as client:
        client.get("/api/health", headers={ws._SESSION_HEADER_NAME: ws._SESSION_TOKEN})
        time.sleep(1.0)

    # 2. gateway boot work the stdio/desktop entry does, MCP config load with a configured revit server
    import tui_gateway.server as server
    import tui_gateway.entry as entry
    entry.ensure_mcp_discovery_started()
    from hermes_cli.model_switch_providers import prewarm_picker_cache_async
    prewarm_picker_cache_async()
    time.sleep(1.5)

    # 2b. the read-only RPCs a desktop shell calls while it boots
    rpc_errors = {}
    for method in ("ping", "gateway.capabilities", "config.get", "commands.catalog", "tools.list", "toolsets.list",
                   "setup.status", "profiles.list", "projects.list", "free_tier.status", "i18n.catalog",
                   "i18n.languages", "degram.credentials.status"):
        params = {"key": "full"} if method == "config.get" else {"lang": "en"} if method == "i18n.catalog" else {}
        try:
            response = server.handle_request({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}) or {}
        except Exception as exc:  # a contract/handler failure is not an egress finding; the guard decides
            rpc_errors[method] = "raised " + type(exc).__name__
            continue
        if "error" in response:
            rpc_errors[method] = response["error"].get("message", "")[:120]
    time.sleep(1.0)

    # 3. one turn
    agent = server._make_agent("sid", "key", platform_override="desktop")
    result = agent.run_conversation("hi")
    time.sleep(1.5)
    print("RESULT::" + json.dumps({"final": result.get("final_response"), "attempts": sorted(set(attempts)), "rpc_errors": rpc_errors,
                      "relay": [(r["method"], r["path"]) for r in relay.requests]}))
"""


class TestSocketGuard:
    def test_startup_and_one_turn_contact_no_host_but_loopback(self, tmp_path):
        home = tmp_path / "home-degram"
        home.mkdir(exist_ok=True)
        (home / "config.yaml").write_text(
            "mcp_servers:\n  revit:\n    command: definitely-not-installed-revit-mcp\n", encoding="utf-8")
        out = run_py(SOCKET_SCRIPT, tmp_path, degram=True, timeout=420,
                     extra_env={"HERMES_DASHBOARD_SESSION_TOKEN": "t" * 24})
        offenders = sorted(h for h in out["attempts"] if h not in {"127.0.0.1", "localhost", "::1", "0.0.0.0", ""})
        assert offenders == [], f"non-loopback contact in variant degram: {offenders}"
        assert out["final"] == "hello from relay"
        assert not [m for m, msg in out["rpc_errors"].items() if "DEGRAM_LOCKED" in msg], out["rpc_errors"]
        assert {tuple(r) for r in out["relay"]} == {("POST", "/data-service/degram/v1/chat/completions")}
