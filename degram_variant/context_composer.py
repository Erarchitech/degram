"""The context the user sees is the context that is sent (1301 D-14, D-17, DGCL-07).

``ContextComposer.preview`` reads the pinned document (identity first), applies the client-side limits, discloses
what was cut or is missing and returns the *exact payload text*. ``prepare_send`` embeds that very text, unchanged,
in the user message and arms the relay provenance headers. Secrets never enter a payload: the composer holds no
credential (the DG backend reads go through ``DgClient``) and a test scans the payload for the token.

Limits (``SNAPSHOT_LIMITS``) are applied here, independent of the server: 200 objects, 50 parameters per object and
256 KiB of payload. Whole-definition scope needs an explicit consent flag on send; a relay ``POLICY_DENY`` is terminal
and is never turned into a send by consent (the relay decides, see ``provider.relay_outcome``)."""

from __future__ import annotations

import json
import secrets
import threading
from collections import OrderedDict
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from . import relay_headers
from .cancel import CancelRegistry, CancelToken
from .credentials import DegramCredentialsError, credentials as _credentials
from .dg_client import DgClient
from .documents import DocumentsService
from .gh_bridge import GH_PREVIEW_READ_TIMEOUT_S
from .outcomes import (
    ACCESS_DENIED,
    CANCELLED,
    CONSENT_REQUIRED,
    DG_UNAVAILABLE,
    DOCUMENT_NOT_OPEN,
    SCOPE_NOT_SUPPORTED,
    BridgeError,
)
from .revit_bridge import REVIT_PREVIEW_DEADLINE_S
from .snapshot import Snapshot

# Preview budget (1301-19, G-14): bridge read <= 20 s (REVIT_PREVIEW_DEADLINE_S / GH_PREVIEW_READ_TIMEOUT_S) + DG
# connect 5 s + rules read PREVIEW_RULES_READ_TIMEOUT_S = 15 s -> worst case 40 s, under the renderer's 45 s preview
# RPC timeout (PREVIEW_RPC_TIMEOUT_MS), so a blocked bridge or a slow DG answers with a named outcome, never a timeout.
PREVIEW_RULES_READ_TIMEOUT_S = 15.0
PREVIEW_BRIDGE_DEADLINE_S = MappingProxyType({
    "revit": REVIT_PREVIEW_DEADLINE_S, "grasshopper": GH_PREVIEW_READ_TIMEOUT_S})
SNAPSHOT_LIMITS = MappingProxyType({"max_objects": 200, "max_parameters": 50, "max_bytes": 256 * 1024})
RULE_LIMIT = 200
RULE_TEXT_LIMIT = 2000
MAX_PREVIEWS = 16
SCOPES = relay_headers.SCOPES
_OBJECTS_KEY = {"grasshopper": "nodes", "revit": "elements"}
_ID_ALPHABET = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")


class ContextError(Exception):
    """A request the composer refuses for what it is (unknown/stale preview, bad scope): a JSON-RPC error, not an
    operational outcome of a bridge call."""

    def __init__(self, code: str, message: str, rpc_code: int = 4400) -> None:
        super().__init__(f"{code}: {message}")
        self.code, self.message, self.rpc_code = code, message, rpc_code


@dataclass(frozen=True)
class SendPlan:
    message: str
    scope: str
    consent: bool
    preview_id: str
    bytes: int


@dataclass
class _Stored:
    preview_id: str
    payload: str
    scope: str
    requested_scope: str
    scope_key: tuple[str, str | None, str]
    generation: int


def _line(text: Any) -> str:
    return " ".join(str(text).split())


def _doc_info(document: dict[str, Any] | None) -> dict[str, Any] | None:
    if not document:
        return None
    return {"app": document.get("app"), "name": document.get("name"), "path": document.get("path"),
            "identity": document.get("identity")}


class ContextComposer:
    def __init__(self, documents: DocumentsService, dg: DgClient | None = None, cancels: CancelRegistry | None = None,
                 limits=SNAPSHOT_LIMITS) -> None:
        self._documents = documents
        self._dg = dg or DgClient()
        self._cancels = cancels or CancelRegistry()
        self._limits = limits
        self._lock = threading.Lock()
        self._previews: OrderedDict[str, _Stored] = OrderedDict()

    # -- preview ---------------------------------------------------------------------------------
    def preview(self, scope: str, *, preview_id: str | None = None) -> dict[str, Any]:
        if scope not in SCOPES:
            raise ContextError("SCOPE_INVALID", f"scope must be one of {', '.join(SCOPES)}")
        pid = preview_id or f"pv_{secrets.token_hex(8)}"
        if not pid or any(c not in _ID_ALPHABET for c in pid) or len(pid) > 64:
            raise ContextError("PREVIEW_ID_INVALID", "previewId must be 1-64 letters, digits, '_' or '-'")
        with self._lock:
            if pid in self._previews:
                raise ContextError("PREVIEW_EXISTS", f"previewId {pid!r} is already in use", 4409)
        token = self._cancels.new(pid)
        try:
            with token.active():
                return self._build(pid, scope, token)
        except BridgeError as exc:
            return {**exc.to_dict(), "previewId": pid}
        finally:
            self._cancels.discard(pid, token)

    def _build(self, pid: str, requested: str, cancel: CancelToken) -> dict[str, Any]:
        try:
            info = _credentials.require_info()
        except DegramCredentialsError as exc:
            raise BridgeError(exc.code, None, str(exc).split(": ", 1)[-1]) from exc
        generation = self._documents.generation
        pinned = self._documents.pinned
        scope = requested
        if scope != "none" and pinned is None:
            if scope == "whole-definition":
                raise BridgeError(SCOPE_NOT_SUPPORTED, "NO_DOCUMENT_PINNED",
                                  "Whole-definition scope needs a pinned Grasshopper document.")
            scope = "none"  # the card says so: no document selected, the request uses project data only
        if scope == "whole-definition" and pinned and pinned["app"] != "grasshopper":
            raise BridgeError(SCOPE_NOT_SUPPORTED, "WHOLE_DEFINITION_GH_ONLY",
                              "Whole-definition scope is offered for Grasshopper definitions only.")
        snapshot = None
        if scope != "none":
            snapshot = self._documents.read_snapshot(
                scope, info.project, cancel, deadline_s=PREVIEW_BRIDGE_DEADLINE_S.get(pinned["app"] if pinned else ""))
        missing: list[dict[str, Any]] = list(snapshot.missing) if snapshot else []
        try:
            rules = self._dg.get_rules(cancel, read_timeout_s=PREVIEW_RULES_READ_TIMEOUT_S)
        except BridgeError as exc:
            if exc.code in (DG_UNAVAILABLE, ACCESS_DENIED):
                rules = []
                missing.append({"what": "rules", "reason": exc.code})
            else:
                raise
        if cancel.cancelled:
            raise BridgeError(CANCELLED, "CANCELLED_BY_USER", "The read was cancelled.")
        view = self._compose(info.project, pinned, scope, snapshot, rules, missing)
        view.pop("_snapshot", None)
        stored = _Stored(pid, view["payload"], scope, requested, (info.user, info.company, info.project), generation)
        with self._lock:
            self._previews[pid] = stored
            while len(self._previews) > MAX_PREVIEWS:
                self._previews.popitem(last=False)
        return {"status": "ok", "previewId": pid, "scope": scope, "requestedScope": requested,
                "requiresConsent": scope == "whole-definition", "limits": dict(self._limits), **view}

    # -- payload ---------------------------------------------------------------------------------
    def _compose(self, project: str, pinned: dict[str, Any] | None, scope: str, snapshot: Snapshot | None,
                 rules: list[dict[str, Any]], missing: list[dict[str, Any]]) -> dict[str, Any]:
        max_objects, max_params, max_bytes = (self._limits["max_objects"], self._limits["max_parameters"],
                                              self._limits["max_bytes"])
        truncation: list[dict[str, Any]] = list(snapshot.source_truncation) if snapshot else []
        # rules
        kept_rules = [{"ruleId": r["ruleId"], "text": r["text"][:RULE_TEXT_LIMIT]} for r in rules[:RULE_LIMIT]]
        if len(rules) > RULE_LIMIT:
            truncation.append({"what": "rules", "kept": len(kept_rules), "total": len(rules)})
        # objects and parameters
        objects: list[dict[str, Any]] = []
        params_total = params_kept = 0
        total_objects = 0
        objects_key = "objects"
        if snapshot is not None:
            objects_key = _OBJECTS_KEY.get(snapshot.app, "objects")
            total_objects = snapshot.total_objects if snapshot.total_objects is not None else len(snapshot.objects)
            for obj in snapshot.objects[:max_objects]:
                listed = obj.get(snapshot.params_key)
                listed = listed if isinstance(listed, list) else []
                host_total = obj.get("parametersTotal") if isinstance(obj.get("parametersTotal"), int) else len(listed)
                params_total += max(host_total, len(listed))
                trimmed = listed[:max_params]
                params_kept += len(trimmed)
                copy = dict(obj)
                if snapshot.params_key in copy:
                    copy[snapshot.params_key] = trimmed
                objects.append(copy)
            if params_kept < params_total:
                truncation.append({"what": "parameters", "kept": params_kept, "total": params_total})
        doc = _doc_info(pinned)

        def snapshot_body(n: int) -> dict[str, Any] | None:
            if snapshot is None:
                return None
            body: dict[str, Any] = {"app": snapshot.app}
            definition = snapshot.extras.get("definition")
            if definition is not None:
                body["definition"] = definition
            body[objects_key] = objects[:n]
            ids = {str(o.get("instanceId", "")).lower() for o in objects[:n]}
            wires = snapshot.extras.get("wires")
            if isinstance(wires, list):
                body["wires"] = [w for w in wires if str(w.get("fromNode", "")).lower() in ids
                                 and str(w.get("toNode", "")).lower() in ids]
            if snapshot.scope == "whole-definition":
                body["object"] = snapshot.extras.get("object")
                body["algorithms"] = snapshot.extras.get("algorithms") or []
            return body

        def object_entries(n: int) -> list[dict[str, Any]]:
            return [{"what": "objects", "kept": n, "total": total_objects}] if snapshot is not None and n < total_objects else []

        def render(n: int, rule_list: list[dict[str, Any]], structure: bool = True) -> str:
            body_snapshot = snapshot_body(n)
            if body_snapshot is not None and not structure:
                body_snapshot.pop("algorithms", None)
                body_snapshot.pop("object", None)
                body_snapshot.pop("wires", None)
            body = {"project": project, "scope": scope, "document": doc, "rules": rule_list, "fragments": [],
                    "snapshot": body_snapshot, "truncation": truncation + object_entries(n), "missing": missing}
            head = (f"DeGram context (scope: {scope})\nproject: {_line(project)}\n"
                    f"document: {_line(doc['name']) + ' [' + str(doc['app']) + ']' if doc else '(none)'}\n")
            return head + json.dumps(body, ensure_ascii=True, separators=(",", ":"))

        n = len(objects)
        payload = render(n, kept_rules)
        full_bytes = len(payload.encode("utf-8"))
        if full_bytes > max_bytes:
            lo, hi = 0, n  # largest n whose payload fits, rules and structure kept
            if len(render(0, kept_rules).encode("utf-8")) <= max_bytes:
                while lo < hi:
                    mid = (lo + hi + 1) // 2
                    if len(render(mid, kept_rules).encode("utf-8")) <= max_bytes:
                        lo = mid
                    else:
                        hi = mid - 1
                n = lo
                payload = render(n, kept_rules)
            else:  # the rules and structure alone are too big: give up structure, then rules
                n = 0
                payload = render(0, kept_rules, structure=False)
                if len(payload.encode("utf-8")) > max_bytes:
                    missing.append({"what": "rules", "reason": "PAYLOAD_TOO_LARGE"})
                    kept_rules = []
                    payload = render(0, kept_rules, structure=False)
        final_bytes = len(payload.encode("utf-8"))
        shown = truncation + object_entries(n)
        if final_bytes < full_bytes:
            shown = shown + [{"what": "bytes", "kept": final_bytes, "total": full_bytes}]
        kept_params = sum(len(o.get(snapshot.params_key) or []) for o in objects[:n]) if snapshot else 0
        summary = {
            "project": project, "document": {k: doc[k] for k in ("app", "name", "path")} if doc else None,
            "objects": n if snapshot else 0, "parameters": kept_params, "rules": len(kept_rules), "fragments": 0,
            "bytes": final_bytes, "emptySelection": bool(snapshot and snapshot.empty_selection),
        }
        return {"payload": payload, "summary": summary, "truncation": shown, "missing": missing,
                "document": doc, "_snapshot": snapshot_body(n)}

    # -- agent tool ------------------------------------------------------------------------------
    def agent_snapshot(self, cancel: CancelToken | None = None) -> dict[str, Any]:
        """The pinned document's current selection, bounded exactly like a preview, for the agent tool
        ``degram_document_snapshot``. Selection scope only: whole-definition goes through the context card and its
        consent, never through a tool call. Raises ``BridgeError`` (no pin, identity, bridge outcomes)."""
        try:
            info = _credentials.require_info()
        except DegramCredentialsError as exc:
            raise BridgeError(exc.code, None, str(exc).split(": ", 1)[-1]) from exc
        pinned = self._documents.pinned
        if pinned is None:
            raise BridgeError(DOCUMENT_NOT_OPEN, "NO_DOCUMENT_PINNED", "No document is pinned. Ask the user to select one.")
        snapshot = self._documents.read_snapshot("selection", info.project, cancel)
        view = self._compose(info.project, pinned, "selection", snapshot, [], list(snapshot.missing) if snapshot else [])
        return {"status": "ok", "scope": "selection", "document": view["document"], "summary": view["summary"],
                "truncation": view["truncation"], "missing": view["missing"], "snapshot": view["_snapshot"]}

    # -- send ------------------------------------------------------------------------------------
    def prepare_send(self, preview_id: str, text: str, *, consent: bool = False, scope: str | None = None) -> SendPlan:
        if not isinstance(text, str) or not text.strip():
            raise ContextError("TEXT_EMPTY", "The message is empty.")
        with self._lock:
            stored = self._previews.get(preview_id)
        if stored is None:
            raise ContextError("PREVIEW_UNKNOWN", f"No preview {preview_id!r}; preview the context again.", 4409)
        if scope is not None and scope not in (stored.scope, stored.requested_scope):
            raise ContextError("PREVIEW_SCOPE_MISMATCH",
                               f"The preview was made for scope {stored.scope!r}, not {scope!r}.", 4409)
        info = _credentials.info()
        if info is None or (info.user, info.company, info.project) != stored.scope_key \
                or stored.generation != self._documents.generation:
            raise ContextError("PREVIEW_STALE", "The project or the pinned document changed since this preview.", 4409)
        if stored.scope == "whole-definition" and consent is not True:
            raise BridgeError(CONSENT_REQUIRED, "CONSENT_NOT_GIVEN",
                              "Sending the whole definition needs the user's confirmation; nothing was sent.")
        message = f"{stored.payload}\n\nRequest:\n{text}"
        relay_headers.set_turn_context(stored.scope, consent=stored.scope == "whole-definition" and consent is True)
        return SendPlan(message=message, scope=stored.scope,
                        consent=stored.scope == "whole-definition" and consent is True,
                        preview_id=preview_id, bytes=len(stored.payload.encode("utf-8")))

    # -- lifecycle -------------------------------------------------------------------------------
    def cancel(self, preview_id: str | None = None) -> int:
        return self._cancels.cancel(preview_id)

    def clear(self) -> None:
        """Scope change or sign-out: previews of the old scope are gone."""
        with self._lock:
            self._previews.clear()
        relay_headers.clear()
