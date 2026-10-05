"""Loopback client for the DG Canvas bridge (Grasshopper), limited to read commands (1301 D-13..D-15, plan 11).

Wire contract (``DG/src/DG.Core/Bridge/CanvasBridgeProtocol.cs``): one newline-terminated UTF-8 JSON request
``{"type": ..., "parameters": {...}}``, one newline-terminated JSON envelope
``{"bridge": "dg", "version": 1, "status": "ok" | "error", "result" | "error": {...}}``.

This is the DeGram twin of ``data-service/gh_bridge.py`` and shares nothing with it: the host is the constant
``127.0.0.1`` (D-15, T-1301-11-06: no environment variable, no parameter, no ``host.docker.internal``), only the four
commands of ``CanvasBridgeCommands.ReadCommands`` can be sent (T-1301-11-01), the response is capped by a *byte*
count, and every wait polls a cancel token so a read can be abandoned within a second (D-18). A failed read is
reported once with its named outcome and is never retried.
"""

from __future__ import annotations

import json
import socket
import time
from typing import Any

from .cancel import POLL_INTERVAL_S, CancelToken, check
from .outcomes import (
    BRIDGE_OFF,
    BUSY,
    DEGRAM_LOCKED,
    DOCUMENT_NOT_OPEN,
    EXTENSION_NOT_LOADED,
    IDENTITY_MISMATCH,
    SETUP_INCOMPLETE,
    BridgeError,
)
from .snapshot import Snapshot

GH_HOST = "127.0.0.1"  # constant on purpose
GH_PORT = 8720
GH_APP = "grasshopper"
# Mirror of CanvasBridgeCommands.ReadCommands (the Python side cannot import the C# constant).
GH_READ_COMMANDS = frozenset({"get_canvas_context", "get_selection", "get_preview_status", "get_document_identity"})
CONNECT_TIMEOUT_S = 2.0
READ_TIMEOUT_S = 30.0
MAX_RESPONSE_BYTES = 10 * 1024 * 1024  # 10 MiB, counted in bytes

_monotonic = time.monotonic  # patched by tests to simulate a listener that never answers


class GhBridgeClient:
    """One request per connection, read commands only."""

    def __init__(self, port: int | None = None) -> None:
        self._port = port

    def _address(self) -> tuple[str, int]:
        return GH_HOST, self._port if self._port is not None else GH_PORT

    def call(self, command: str, parameters: dict | None = None, *, cancel: CancelToken | None = None) -> Any:
        if command not in GH_READ_COMMANDS:  # raises before any connection is opened
            raise BridgeError(DEGRAM_LOCKED, "GH_COMMAND_NOT_ALLOWED",
                              f"Grasshopper bridge command {command!r} is not a read command.")
        check(cancel)
        sock = self._connect()
        try:
            request = json.dumps({"type": command, "parameters": parameters or {}}) + "\n"
            try:
                sock.sendall(request.encode("utf-8"))
            except OSError as exc:
                raise BridgeError(BRIDGE_OFF, "CONNECTION_LOST", f"Grasshopper bridge connection failed: {exc}") from exc
            line = self._read_line(sock, cancel)
        finally:
            try:
                sock.close()
            except OSError:
                pass
        return self._result(line, command)

    # -- transport -----------------------------------------------------------------------------
    def _connect(self) -> socket.socket:
        try:
            sock = socket.create_connection(self._address(), timeout=CONNECT_TIMEOUT_S)
        except (OSError, socket.timeout) as exc:  # refused, unreachable, timed out: the bridge is not listening
            raise BridgeError(BRIDGE_OFF, "CONNECT_FAILED",
                              "Grasshopper bridge is not reachable on the loopback port. Start Rhino and enable "
                              "DG CANVAS LISTENER.") from exc
        sock.settimeout(POLL_INTERVAL_S)
        return sock

    def _read_line(self, sock: socket.socket, cancel: CancelToken | None) -> bytes:
        deadline = _monotonic() + READ_TIMEOUT_S
        buffer = bytearray()
        while True:
            check(cancel)
            if _monotonic() >= deadline:
                raise BridgeError(BUSY, "NO_RESPONSE", "Grasshopper did not answer in time.")
            try:
                chunk = sock.recv(65536)
            except socket.timeout:
                continue
            except OSError as exc:
                raise BridgeError(BRIDGE_OFF, "CONNECTION_LOST", f"Grasshopper bridge connection lost: {exc}") from exc
            if not chunk:
                raise BridgeError(BRIDGE_OFF, "CLOSED_WITHOUT_RESPONSE", "Grasshopper bridge closed the connection "
                                  "without a response.")
            buffer += chunk
            newline = buffer.find(b"\n")
            if newline != -1:
                return bytes(buffer[:newline])
            if len(buffer) > MAX_RESPONSE_BYTES:
                raise BridgeError(SETUP_INCOMPLETE, "RESPONSE_TOO_LARGE",
                                  f"Grasshopper bridge response exceeded {MAX_RESPONSE_BYTES} bytes.")

    # -- envelope ------------------------------------------------------------------------------
    @staticmethod
    def _result(line: bytes, command: str) -> Any:
        if len(line) > MAX_RESPONSE_BYTES:
            raise BridgeError(SETUP_INCOMPLETE, "RESPONSE_TOO_LARGE",
                              f"Grasshopper bridge response exceeded {MAX_RESPONSE_BYTES} bytes.")
        try:
            envelope = json.loads(line.decode("utf-8"))
        except ValueError as exc:
            raise BridgeError(SETUP_INCOMPLETE, "BRIDGE_PROTOCOL", "Grasshopper bridge returned a malformed response. "
                              "Check the DG CANVAS LISTENER version.") from exc
        if not isinstance(envelope, dict) or envelope.get("bridge") != "dg":
            raise BridgeError(SETUP_INCOMPLETE, "BRIDGE_PROTOCOL", "The listener on the Grasshopper bridge port is not "
                              "the DG CANVAS LISTENER.")
        if envelope.get("status") == "error":
            error = envelope.get("error") if isinstance(envelope.get("error"), dict) else {}
            code, message = str(error.get("code") or ""), str(error.get("message") or "The bridge returned an error.")
            if code == "BUSY":
                raise BridgeError(BUSY, "UI_THREAD_BUSY", message)
            if code == "UNKNOWN_COMMAND":
                raise BridgeError(EXTENSION_NOT_LOADED, "UNKNOWN_COMMAND",
                                  f"The DG CANVAS LISTENER does not know {command}; update the DG plugin.")
            if code == "HANDLER_ERROR" and "no active document" in message.lower():
                raise BridgeError(DOCUMENT_NOT_OPEN, "NO_DOCUMENT_OPEN", message)
            raise BridgeError(SETUP_INCOMPLETE, f"BRIDGE_{code or 'ERROR'}", message)
        if envelope.get("status") != "ok":
            raise BridgeError(SETUP_INCOMPLETE, "BRIDGE_PROTOCOL", "Grasshopper bridge returned an unknown status.")
        return envelope.get("result")


class GhDocumentSource:
    """Documents and snapshots of Grasshopper as the picker and the composer see them."""

    app = GH_APP

    def __init__(self, client: GhBridgeClient | None = None) -> None:
        self.client = client or GhBridgeClient()

    @staticmethod
    def _row(identity: dict[str, Any]) -> dict[str, Any]:
        path = identity.get("filePath") or None
        return {
            "app": GH_APP, "name": identity.get("displayName") or "(untitled)", "path": path, "unsaved": path is None,
            "identity": {"documentId": identity.get("documentId"), "filePath": path},
            "isModified": bool(identity.get("isModified")), "isActive": True,
        }

    def list_documents(self, cancel: CancelToken | None = None) -> list[dict[str, Any]]:
        identity = self.client.call("get_document_identity", {}, cancel=cancel)
        if not isinstance(identity, dict) or not identity.get("documentId"):
            raise BridgeError(SETUP_INCOMPLETE, "BRIDGE_PROTOCOL", "get_document_identity returned no document id.")
        return [self._row(identity)]

    def read_snapshot(self, pinned: dict[str, Any], scope: str, project: str,
                      cancel: CancelToken | None = None) -> Snapshot:
        """Identity first, then the existing DG serializer (D-14/D-15): ``get_canvas_context`` filtered by
        ``get_selection``. The pinned document is the only document that can answer."""
        wanted = (pinned.get("identity") or {}).get("documentId")
        identity = self.client.call("get_document_identity", {}, cancel=cancel)
        if not isinstance(identity, dict) or identity.get("documentId") != wanted:
            raise BridgeError(IDENTITY_MISMATCH, "DOCUMENT_ID_DIFFERS",
                              "The Grasshopper document answering is not the pinned document; nothing was read.")
        document = {**pinned, "name": identity.get("displayName") or pinned.get("name"),
                    "path": identity.get("filePath") or None}
        selected: set[str] = set()
        if scope == "selection":
            reply = self.client.call("get_selection", {}, cancel=cancel)
            guids = reply.get("selection") if isinstance(reply, dict) else None
            selected = {str(g).lower() for g in guids or []}
            if not selected:
                return Snapshot(app=GH_APP, document=document, objects=[], params_key="inputParams", scope=scope,
                                empty_selection=True, total_objects=0)
        context = self.client.call("get_canvas_context", {"project": project}, cancel=cancel)
        if not isinstance(context, dict):
            raise BridgeError(SETUP_INCOMPLETE, "BRIDGE_PROTOCOL", "get_canvas_context returned no document.")
        if (context.get("definition") or {}).get("documentId") != wanted:
            raise BridgeError(IDENTITY_MISMATCH, "CONTEXT_DOCUMENT_DIFFERS",
                              "The canvas context belongs to another document; nothing was used.")
        nodes = [n for n in context.get("nodes") or [] if isinstance(n, dict)]
        extras: dict[str, Any] = {"definition": context.get("definition")}
        wires = [w for w in context.get("wires") or [] if isinstance(w, dict)]
        if scope == "selection":
            nodes = [n for n in nodes if str(n.get("instanceId", "")).lower() in selected]
            kept = {str(n.get("instanceId", "")).lower() for n in nodes}
            wires = [w for w in wires if str(w.get("fromNode", "")).lower() in kept
                     and str(w.get("toNode", "")).lower() in kept]
        else:
            extras["object"] = context.get("object")
            extras["algorithms"] = context.get("algorithms") or []
        extras["wires"] = wires
        return Snapshot(app=GH_APP, document=document, objects=nodes, params_key="inputParams", scope=scope,
                        total_objects=len(nodes), extras=extras, empty_selection=scope == "selection" and not nodes)
