"""Variant degram lockdown (1301 D-16/D-22, DGCL-02, D-03): the mode switch and every closed surface.

Everything here is a no-op unless ``HERMES_DEGRAM=1``. The core carries only one-line hooks into
this module (``tools/registry.py``, ``tui_gateway/rpc_dispatch.py`` + ``server.py``,
``agent/auxiliary_client.py``, ``hermes_cli/config.py``, ``hermes_cli/web_server.py``,
``tools/mcp_tool*.py``, ``agent/model_metadata*.py``), so upstream merges stay small. Closed means
closed in code (the registry never registers a forbidden tool, an RPC handler never runs, an
auxiliary client is never built), not hidden from a schema.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

ENV_DEGRAM = "HERMES_DEGRAM"
DEGRAM_LOCKED = "DEGRAM_LOCKED"
DEGRAM_LOCKED_RPC_CODE = 4403


def is_degram() -> bool:
    """True only when the environment says ``HERMES_DEGRAM=1`` (exactly ``1``)."""
    import os

    return os.environ.get(ENV_DEGRAM) == "1"


class DegramLockedError(Exception):
    """A surface that variant degram closes. ``code`` is always DEGRAM_LOCKED."""

    code = DEGRAM_LOCKED


# ── tools (D-22) ─────────────────────────────────────────────────────────────────────────────

# The degram toolset names are reserved here and registered by plan 11; the eight read tools of the
# pinned revit-mcp server come from plan 07. ``todo_list`` is the registered name of the ``todo`` toolset.
DEGRAM_TOOL_NAMES = frozenset({
    "degram_project_graph", "degram_document_snapshot", "degram_list_documents", "degram_bridge_status"})
REVIT_TOOL_NAMES = frozenset({
    "mcp__revit__get_revit_status", "mcp__revit__get_revit_model_info", "mcp__revit__list_open_documents",
    "mcp__revit__get_selection_snapshot", "mcp__revit__get_element_properties", "mcp__revit__list_levels",
    "mcp__revit__get_current_view_info", "mcp__revit__list_category_parameters"})
ALLOWED_TOOL_NAMES = frozenset({"clarify", "todo_list"}) | DEGRAM_TOOL_NAMES | REVIT_TOOL_NAMES
ALLOWED_TOOLSETS = ("clarify", "todo", "degram", "mcp-revit")
ALLOWED_MCP_SERVERS = frozenset({"revit"})
# Built-in tool modules that may be imported at all in variant degram (``tools.degram*`` is plan 11's).
ALLOWED_TOOL_MODULES = frozenset({"tools.clarify_tool", "tools.todo_tool"})


def tool_name_allowed(name: str) -> bool:
    """Registry gate (``ToolRegistry.register``): outside variant degram everything registers."""
    return not is_degram() or name in ALLOWED_TOOL_NAMES


def tool_module_allowed(module_name: str) -> bool:
    """Discovery gate (``discover_builtin_tools``): a stock tool module is not even imported."""
    return not is_degram() or module_name in ALLOWED_TOOL_MODULES or module_name.startswith("tools.degram")


def enabled_toolsets() -> list[str]:
    """The fixed toolset selection of every degram session, whatever the surface, coding posture,
    operator pin or config says."""
    return list(ALLOWED_TOOLSETS)


# ── auxiliary routes (D-16) ──────────────────────────────────────────────────────────────────

# Compression is the one auxiliary the agent needs to keep long conversations alive; it runs on the
# pinned relay route (the main route). Every other auxiliary task is disabled.
ALLOWED_AUX_TASKS = frozenset({"compression"})


def aux_task_allowed(task: str | None) -> bool:
    return bool(task) and task in ALLOWED_AUX_TASKS


def aux_explicit_route_allowed(base_url: str | None) -> bool:
    """An explicit auxiliary endpoint is honoured only when it IS the pinned relay route."""
    if not base_url:
        return False
    from .credentials import credentials
    from .provider import relay_v1_url

    info = credentials.info()
    return info is not None and str(base_url).rstrip("/") == relay_v1_url(info.relay_base_url)


# ── network kill switches (D-03) ─────────────────────────────────────────────────────────────

# The relay's real context window is the operator's choice (the relay overrides the model); this
# conservative default stands in for every catalog/endpoint probe, which variant degram never makes.
# ``model.context_length`` in the generated profile config (config_template.yaml) wins over it.
DEGRAM_DEFAULT_CONTEXT_LENGTH = 128_000


def degram_context_length() -> int | None:
    """The fixed context length in variant degram, None elsewhere (hook in ``get_model_context_length``)."""
    return DEGRAM_DEFAULT_CONTEXT_LENGTH if is_degram() else None


def block_metadata_egress(url: str) -> None:
    """Variant degram makes no model-metadata/catalog probe (``agent/model_metadata_http.stream`` is the
    one choke point). Callers treat metadata as optional, so a refused probe reads as 'unreachable'."""
    if is_degram():
        raise ConnectionError(f"variant degram: model-metadata probe to {url!r} is disabled")


# ── MCP (D-22/D-23) ──────────────────────────────────────────────────────────────────────────


def lock_mcp_server_config(cfg: dict) -> dict:
    """One MCP server entry as variant degram runs it: stdio only (no remote url/headers/auth), sampling
    and elicitation off. Returns a copy; the input is untouched."""
    out = {k: v for k, v in cfg.items() if k not in {"url", "headers", "auth", "oauth", "transport"}}
    out["sampling"] = {"enabled": False}
    out["elicitation"] = {"enabled": False}
    return out


def lock_mcp_servers(servers: dict[str, Any]) -> dict[str, Any]:
    """Hook in ``_filter_suspicious_mcp_servers`` (every native, portable and explicit registration):
    only the allowlisted stdio servers survive."""
    if not is_degram():
        return servers
    kept: dict[str, Any] = {}
    for name, cfg in servers.items():
        if name not in ALLOWED_MCP_SERVERS or not isinstance(cfg, dict) or not cfg.get("command"):
            logger.warning("variant degram: MCP server %r is not allowed (allowlist %s, stdio only)",
                           name, sorted(ALLOWED_MCP_SERVERS))
            continue
        kept[name] = lock_mcp_server_config(cfg)
    return kept


def osv_preflight_disabled() -> bool:
    """Only the pinned in-repo revit-mcp server is configured (T-1301-10-06), so the OSV malware
    preflight (a network call to osv.dev) is skipped in variant degram."""
    return is_degram()


# ── configuration (the locked values win over config.yaml and the managed scope) ─────────────


def lock_config(cfg: dict) -> dict:
    """Force the degram invariants onto a loaded config (hook in ``hermes_cli.config._merge_managed_overlay``).
    A user edit of ``config.yaml`` cannot re-open a provider, a toolset, an MCP transport or a network call."""
    if not is_degram():
        return cfg
    from .provider import DEGRAM_MODEL_ALIAS

    def section(key: str) -> dict:
        value = cfg.get(key)
        if not isinstance(value, dict):
            value = {}
        cfg[key] = value
        return value

    model = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
    cfg["model"] = {"provider": "custom", "default": DEGRAM_MODEL_ALIAS,
                    **({"context_length": model["context_length"]} if model.get("context_length") else {})}
    cfg["fallback_providers"] = []
    cfg.pop("fallback_model", None)
    cfg["providers"] = {}
    cfg.pop("custom_providers", None)
    cfg["toolsets"] = enabled_toolsets()
    platform_toolsets = section("platform_toolsets")
    for platform in {"cli", "desktop", "tui", *platform_toolsets}:
        platform_toolsets[platform] = enabled_toolsets()
    servers = cfg.get("mcp_servers")
    cfg["mcp_servers"] = lock_mcp_servers(servers if isinstance(servers, dict) else {})

    section("tools").setdefault("tool_search", {})["enabled"] = "off"  # the allowlisted tools stay directly visible
    section("model_catalog")["enabled"] = False
    shared = section("telemetry").setdefault("shared_metrics", {})
    shared["enabled"], shared["send"] = False, False
    section("updates")["check"] = False
    section("nous")["guest"] = False
    section("curator")["enabled"] = False
    plugins = section("plugins")
    plugins["auto_update_check_hours"], plugins["auto_apply"] = 0, False
    memory = section("memory")
    memory["memory_enabled"], memory["user_profile_enabled"], memory["provider"] = False, False, ""

    auxiliary = section("auxiliary")
    for task, block in list(auxiliary.items()):
        if not isinstance(block, dict):
            continue
        for key in ("model", "base_url", "api_key", "key_env", "api_key_env", "api_mode"):
            block.pop(key, None)
        block["provider"] = "auto"
        block.pop("fallback_chain", None)
        if task not in ALLOWED_AUX_TASKS:
            block["enabled"] = False
    auxiliary.setdefault("title_generation", {})["model_upgrade_enabled"] = False
    auxiliary.setdefault("background_review", {})["enabled"] = False
    return cfg


# ── RPC (DGCL-02) ────────────────────────────────────────────────────────────────────────────

ALLOWED_RPC_METHODS = frozenset({
    # liveness and capability handshake
    "ping", "gateway.capabilities", "client.capabilities",
    # read-only configuration and catalog introspection
    "config.get", "config.set", "commands.catalog", "complete.slash", "command.resolve", "command.dispatch",
    "slash.exec", "i18n.catalog", "i18n.languages", "tools.list", "tools.show", "toolsets.list", "setup.status",
    "profiles.list", "projects.list", "projects.get", "free_tier.status",
    # the chat session itself
    "session.create", "session.resume", "session.close", "session.list", "session.history", "session.status",
    "session.usage", "session.title", "session.interrupt", "session.steer", "session.compress", "session.undo",
    "session.save", "session.delete", "session.archive", "session.set_hidden", "session.activate",
    "session.active_list", "session.most_recent", "session.events.since", "session.events.stats",
    "session.context_breakdown", "session.branch", "session.branch_stored", "session.branch_whole",
    "session.redirect", "prompt.submit",
    # the two user-answerable server->client requests of the allowlisted tools
    "approval.pending", "approval.received", "approval.respond", "clarify.lock", "request.answer",
    # the delegated credential handoff
    "degram.credentials.set", "degram.credentials.clear", "degram.credentials.status",
    # the CAD read capabilities (plan 11): pick and pin a document, preview and send the context, cancel a read
    "degram.documents.list", "degram.documents.pin", "degram.documents.unpin", "degram.context.preview",
    "degram.context.send", "degram.context.cancel",
})

# ``config.set`` keys that would re-open provider/model/toolset/MCP/auxiliary selection, the working
# directory or the system prompt. Exact keys and dotted prefixes.
LOCKED_CONFIG_KEYS = frozenset({
    "model", "provider", "providers", "custom_providers", "fallback_providers", "fallback_model", "fallback",
    "toolsets", "platform_toolsets", "mcp_servers", "mcp", "auxiliary", "cwd", "terminal.cwd", "workdir", "prompt",
    "personality", "yolo", "approval_mode", "approvals.mode", "approvals", "fast", "reasoning", "delegation",
    "plugins", "nous", "model_catalog", "models_dev", "telemetry", "updates", "terminal", "web", "browser",
    "skills", "memory", "cron", "curator", "hooks", "quick_commands", "voice"})

ALLOWED_SLASH_COMMANDS = frozenset({
    "help", "clear", "new", "reset", "title", "undo", "retry", "usage", "compress", "history", "stop", "status",
    "copy", "quit", "exit"})


def _config_key_locked(key: Any) -> bool:
    if not isinstance(key, str) or not key.strip():
        return True
    root = key.strip().lower()
    return root in LOCKED_CONFIG_KEYS or root.split(".", 1)[0] in LOCKED_CONFIG_KEYS


def _slash_name(params: dict) -> str | None:
    raw = params.get("command") if isinstance(params.get("command"), str) else params.get("name")
    if not isinstance(raw, str) or not raw.strip():
        return None
    first = raw.strip().lstrip("/").split(None, 1)[0] if raw.strip().lstrip("/") else ""
    return first.lower() or None


def assert_rpc_allowed(method: str, params: dict | None) -> None:
    """Raise ``DegramLockedError`` unless ``method`` (with these params) may run in variant degram.
    Deny by default: an RPC the allowlist does not name is locked, including every method a future
    upstream release adds. No-op outside variant degram."""
    if not is_degram():
        return
    params = params if isinstance(params, dict) else {}
    if method not in ALLOWED_RPC_METHODS:
        raise DegramLockedError(f"RPC method {method!r} is not available in DeGram")
    if method == "config.set" and _config_key_locked(params.get("key")):
        raise DegramLockedError(f"config key {params.get('key')!r} is not settable in DeGram")
    if method in {"slash.exec", "command.dispatch", "command.resolve"}:
        name = _slash_name(params)
        if name is None and method == "command.resolve":
            return  # resolving an empty name is a catalog read
        if name not in ALLOWED_SLASH_COMMANDS:
            raise DegramLockedError(f"slash command {('/' + name) if name else '(none)'} is not available in DeGram")


def rpc_locked_response(rid: Any, exc: DegramLockedError, err) -> dict:
    """The JSON-RPC error envelope (``err`` is the gateway's ``_err``)."""
    return err(rid, DEGRAM_LOCKED_RPC_CODE, f"{DEGRAM_LOCKED}: {exc}", {"code": DEGRAM_LOCKED})


# ── REST (DGCL-02) ───────────────────────────────────────────────────────────────────────────

ALLOWED_REST_PATHS = frozenset({"/api/ws", "/api/health", "/api/status"})
# Non-/api routes the dashboard mounts that serve code or schema rather than the SPA shell.
_PRUNED_NON_API_PATHS = frozenset({"/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"})


def prune_rest_routes(app: Any) -> None:
    """Remove every dashboard route variant degram does not need (absent, not hidden) and answer the rest of
    ``/api/*`` with 403 DEGRAM_LOCKED. Called once after the routers are mounted, before the SPA catch-all."""
    if not is_degram():
        return
    from .rest_lock import locked_route

    def keep(route: Any) -> bool:
        path = getattr(route, "path", "")
        if path in ALLOWED_REST_PATHS:
            return True
        if path.startswith("/api/") or path.startswith("/dashboard-plugins/"):
            return False
        return path not in _PRUNED_NON_API_PATHS

    app.router.routes[:] = [route for route in app.router.routes if keep(route)]
    app.router.routes.append(locked_route())  # after the kept /api routes, before the SPA catch-all
