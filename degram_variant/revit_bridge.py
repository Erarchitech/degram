"""Revit as a read-only MCP stdio child, called programmatically (1301 D-11, D-13, D-14, D-23; plan 11).

The Revit adapter (``apps/revit-mcp``, plan 07) is launched by the Hermes MCP client as server ``revit`` (see
``config_template.yaml``: bundled Python, ``DEGRAM_MODE=1``, the eight allowlisted tools, no resources/prompts,
sampling off). It opens no HTTP/SSE port and exits with the gateway (``shutdown_mcp_servers``).

This module calls the *registered* ``mcp__revit__*`` tool handlers, the same code path the agent's tool calls take, so
the circuit breaker, stdio respawn and result rendering are not re-implemented. Each call runs on its own bounded
worker thread: it is abandoned with ``BUSY`` after ``REVIT_DEADLINE_S`` (40 s) and with ``CANCELLED`` the moment the
cancel token or the turn's interrupt fires (the worker's MCP wait is interrupted through the per-thread interrupt
bit and unwinds within 0.1 s). No automatic retry.

Identity (plan 07 residual): only ``get_selection_snapshot`` is addressed by document identity
``{creationGuid, pathName}``; the other read tools read Revit's *active* document. DeGram's own reads (picker,
preview, ``degram_document_snapshot``) use only ``list_open_documents`` and ``get_selection_snapshot``."""

from __future__ import annotations

import contextvars
import json
import threading
import time
from typing import Any

from .cancel import POLL_INTERVAL_S, CancelToken, check
from .outcomes import (
    BRIDGE_OFF,
    BUSY,
    DOCUMENT_NOT_OPEN,
    EXTENSION_NOT_LOADED,
    IDENTITY_MISMATCH,
    ROUTES_DISABLED,
    SCOPE_NOT_SUPPORTED,
    SETUP_INCOMPLETE,
    BridgeError,
)
from .snapshot import Snapshot

REVIT_APP = "revit"
REVIT_SERVER = "revit"
TOOL_PREFIX = f"mcp__{REVIT_SERVER}__"
# The only adapter tools DeGram's own reads use (the other six stay available to the agent as allowlisted reads).
LIST_TOOL = "list_open_documents"
SNAPSHOT_TOOL = "get_selection_snapshot"
REVIT_DEADLINE_S = 40.0  # agent tool calls: matches mcp_servers.revit.timeout in config_template.yaml
# The context PREVIEW read (1301-19, G-14): must answer BUSY before the renderer's preview RPC gives up
# (PREVIEW_RPC_TIMEOUT_MS = 45_000 in use-degram-gateway.ts), so a blocked Revit reads as "busy", not as a timeout.
# Measured selection reads were under 2 s on the pilot PC, so 20 s only trips on a real block (dialog, modal command).
REVIT_PREVIEW_DEADLINE_S = 20.0

_monotonic = time.monotonic  # patched by tests

# Codes the adapter reports itself (apps/revit-mcp/DEGRAM.md "Structured outcomes") -> operational outcomes.
_PASSTHROUGH = {BUSY, BRIDGE_OFF, ROUTES_DISABLED, EXTENSION_NOT_LOADED, IDENTITY_MISMATCH, DOCUMENT_NOT_OPEN}


def _run_bounded(fn, cancel: CancelToken | None, deadline_s: float | None = None):
    """Run ``fn`` on a worker thread; BUSY at the deadline, CANCELLED on cancel/interrupt, without waiting for the
    worker (its MCP wait is interrupted and it unwinds by itself)."""
    deadline_s = REVIT_DEADLINE_S if deadline_s is None else deadline_s
    from tools.interrupt import set_interrupt

    box: dict[str, Any] = {}
    done = threading.Event()
    guard = threading.Lock()
    state = {"finished": False, "tid": None}

    def worker() -> None:
        state["tid"] = threading.get_ident()
        try:
            box["value"] = fn()
        except BaseException as exc:  # noqa: BLE001 - re-raised on the caller's thread
            box["error"] = exc
        finally:
            with guard:
                state["finished"] = True
                set_interrupt(False, state["tid"])
            done.set()

    def abort() -> None:
        with guard:
            if not state["finished"] and state["tid"] is not None:
                set_interrupt(True, state["tid"], reason="degram-cancel")

    thread = threading.Thread(target=contextvars.copy_context().run, args=(worker,), name="degram-revit-read",
                              daemon=True)
    thread.start()
    end = _monotonic() + deadline_s
    while not done.wait(POLL_INTERVAL_S):
        try:
            check(cancel)
        except BridgeError:
            abort()
            raise
        if _monotonic() >= end:
            abort()
            raise BridgeError(BUSY, "NO_RESPONSE", "Revit did not answer in time.")
    if "error" in box:
        raise box["error"]
    return box["value"]


def _parse(output: Any, tool: str) -> dict[str, Any]:
    """The adapter's structured result out of the Hermes handler's JSON (``{"result": "<json text>"}``)."""
    try:
        outer = json.loads(output) if isinstance(output, str) else output
    except ValueError as exc:
        raise BridgeError(SETUP_INCOMPLETE, "ADAPTER_PROTOCOL", f"Revit adapter returned malformed output for {tool}.") from exc
    if not isinstance(outer, dict):
        raise BridgeError(SETUP_INCOMPLETE, "ADAPTER_PROTOCOL", f"Revit adapter returned no object for {tool}.")
    if "error" in outer and "result" not in outer:  # Hermes-level failure (not connected, breaker open, timeout)
        text = str(outer.get("error"))
        if "timed out" in text.lower():
            raise BridgeError(BUSY, "NO_RESPONSE", "Revit did not answer in time.")
        if "interrupted" in text.lower():
            from .outcomes import CANCELLED
            raise BridgeError(CANCELLED, "CANCELLED_BY_USER", "The read was cancelled.")
        raise BridgeError(SETUP_INCOMPLETE, "REVIT_ADAPTER_UNAVAILABLE", text[:300])
    inner = outer.get("result", outer)
    if isinstance(inner, str):
        try:
            inner = json.loads(inner)
        except ValueError as exc:
            raise BridgeError(SETUP_INCOMPLETE, "ADAPTER_PROTOCOL", f"Revit adapter returned non-JSON text for {tool}.") from exc
    if not isinstance(inner, dict):
        raise BridgeError(SETUP_INCOMPLETE, "ADAPTER_PROTOCOL", f"Revit adapter returned no object for {tool}.")
    if inner.get("status") == "error":
        code, reason = str(inner.get("code") or ""), inner.get("reason")
        message = str(inner.get("error") or inner.get("message") or code or "The Revit adapter reported an error.")
        if code in _PASSTHROUGH:
            raise BridgeError(code, reason, message)
        if code == SETUP_INCOMPLETE:  # reason: ROUTES_NOT_LOOPBACK, NO_DOCUMENT_OPEN, REVIT_HOST_NOT_LOOPBACK
            raise BridgeError(SETUP_INCOMPLETE, reason or "SETUP_INCOMPLETE", message)
        raise BridgeError(SETUP_INCOMPLETE, code or "ADAPTER_ERROR", message)
    return inner


class RevitBridgeClient:
    """Calls one allowlisted adapter tool through the registered MCP handler."""

    def call(self, tool: str, arguments: dict[str, Any] | None = None, *,
             cancel: CancelToken | None = None, deadline_s: float | None = None) -> dict[str, Any]:
        from degram_variant.lockdown import REVIT_TOOL_NAMES
        from tools.registry import registry

        name = f"{TOOL_PREFIX}{tool}"
        if name not in REVIT_TOOL_NAMES:  # the adapter allowlist, mirrored: nothing else is ever called
            from .outcomes import DEGRAM_LOCKED
            raise BridgeError(DEGRAM_LOCKED, "REVIT_TOOL_NOT_ALLOWED", f"Revit tool {tool!r} is not an allowlisted read.")
        check(cancel)
        entry = registry.get_entry(name)
        if entry is None:
            raise BridgeError(SETUP_INCOMPLETE, "REVIT_ADAPTER_NOT_CONNECTED",
                              "The Revit adapter is not connected. Check the DeGram settings and the pyRevit extension.")
        output = _run_bounded(lambda: registry.dispatch(name, dict(arguments or {})), cancel, deadline_s)
        return _parse(output, tool)


class RevitDocumentSource:
    """Revit documents and selection snapshots as the picker and the composer see them."""

    app = REVIT_APP

    def __init__(self, client: RevitBridgeClient | None = None) -> None:
        self.client = client or RevitBridgeClient()

    @staticmethod
    def _row(doc: dict[str, Any]) -> dict[str, Any]:
        path = doc.get("pathName") or None
        return {
            "app": REVIT_APP, "name": doc.get("title") or "(untitled)", "path": path, "unsaved": path is None,
            "identity": {"creationGuid": doc.get("creationGuid"), "pathName": path or ""},
            "isModified": bool(doc.get("isModified")), "isActive": bool(doc.get("isActive")),
        }

    def list_documents(self, cancel: CancelToken | None = None) -> list[dict[str, Any]]:
        result = self.client.call(LIST_TOOL, {}, cancel=cancel)
        docs = result.get("documents")
        if not isinstance(docs, list):
            raise BridgeError(SETUP_INCOMPLETE, "ADAPTER_PROTOCOL", "list_open_documents returned no document list.")
        return [self._row(d) for d in docs if isinstance(d, dict) and d.get("creationGuid")]

    def read_snapshot(self, pinned: dict[str, Any], scope: str, project: str,
                      cancel: CancelToken | None = None, deadline_s: float | None = None) -> Snapshot:
        from .context_composer import SNAPSHOT_LIMITS

        if scope != "selection":
            raise BridgeError(SCOPE_NOT_SUPPORTED, "WHOLE_DEFINITION_GH_ONLY",
                              "Revit offers the selection scope only.")
        identity = pinned.get("identity") or {}
        result = self.client.call(SNAPSHOT_TOOL, {
            "identity": {"creationGuid": identity.get("creationGuid"), "pathName": identity.get("pathName") or ""},
            "max_elements": SNAPSHOT_LIMITS["max_objects"], "max_parameters": SNAPSHOT_LIMITS["max_parameters"],
        }, cancel=cancel, deadline_s=deadline_s)
        elements = [e for e in result.get("elements") or [] if isinstance(e, dict)]
        trunc = result.get("truncation") if isinstance(result.get("truncation"), dict) else {}
        total = trunc.get("elementsTotal") if isinstance(trunc.get("elementsTotal"), int) else len(elements)
        return Snapshot(app=REVIT_APP, document=dict(pinned), objects=elements, params_key="parameters", scope=scope,
                        empty_selection=bool(result.get("emptySelection")) or not elements, total_objects=total)
