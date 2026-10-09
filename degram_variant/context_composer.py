"""The context the user sees is the context that is sent (1301 D-14, D-17, DGCL-07).

``ContextComposer.preview`` reads every pinned document (one per bridge, D-29; identity first), applies the
client-side limits per document, discloses what was cut, missing or left out and returns the *exact payload text*. ``prepare_send`` embeds that very text, unchanged,
in the user message and arms the relay provenance headers. Secrets never enter a payload: the composer holds no
credential (the DG backend reads go through ``DgClient``) and a test scans the payload for the token.

Limits (``SNAPSHOT_LIMITS``) are applied here, independent of the server: 200 objects and 50 parameters per object in
each document and 256 KiB for the whole payload. Whole-definition scope needs an explicit consent flag on send; a relay ``POLICY_DENY`` is terminal
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
    bridge_state,
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


def _split_results(pins: dict[str, dict[str, Any]], results: dict[str, Snapshot | BridgeError]
                   ) -> tuple[dict[str, Snapshot], list[dict[str, Any]]]:
    """Readable snapshots, and for every bridge whose read ended in an outcome the exclusion row the card shows
    (D-29: that document is left out; nothing is re-pinned or substituted)."""
    snapshots: dict[str, Snapshot] = {}
    excluded: list[dict[str, Any]] = []
    for app, outcome in results.items():
        if isinstance(outcome, BridgeError):
            row: dict[str, Any] = {"app": app, "name": pins[app].get("name"), "code": outcome.code,
                                   "message": outcome.message}
            if outcome.reason:
                row["reason"] = outcome.reason
            state = bridge_state(outcome.code, outcome.reason)
            if state:
                row["bridgeState"] = state
            excluded.append(row)
        else:
            snapshots[app] = outcome
    return snapshots, excluded


def _effective_scope(requested: str, snapshots: dict[str, Snapshot]) -> str:
    """The scope the payload really carries: whole-definition only while the Grasshopper definition was read whole,
    selection while some document was read, none when every pinned document was excluded."""
    if not snapshots:
        return "none"
    gh = snapshots.get("grasshopper")
    if requested == "whole-definition" and gh is not None and gh.scope == "whole-definition":
        return "whole-definition"
    return "selection"


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
        pins = self._documents.pinned
        scope = requested
        if scope != "none" and not pins:
            if scope == "whole-definition":
                raise BridgeError(SCOPE_NOT_SUPPORTED, "NO_DOCUMENT_PINNED",
                                  "Whole-definition scope needs a pinned Grasshopper document.")
            scope = "none"  # the card says so: no document selected, the request uses project data only
        if scope == "whole-definition" and "grasshopper" not in pins:
            raise BridgeError(SCOPE_NOT_SUPPORTED, "WHOLE_DEFINITION_GH_ONLY",
                              "Whole-definition scope is offered for Grasshopper definitions only.")
        snapshots: dict[str, Snapshot] = {}
        excluded: list[dict[str, Any]] = []
        if scope != "none":
            results = self._documents.read_snapshots(scope, info.project, cancel, deadline_s=PREVIEW_BRIDGE_DEADLINE_S)
            snapshots, excluded = _split_results(pins, results)
            scope = _effective_scope(scope, snapshots)
        missing: list[dict[str, Any]] = [m for snap in snapshots.values() for m in snap.missing]
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
        view = self._compose(info.project, pins, scope, snapshots, excluded, rules, missing)
        view.pop("_snapshots", None)
        stored = _Stored(pid, view["payload"], scope, requested, (info.user, info.company, info.project), generation)
        with self._lock:
            self._previews[pid] = stored
            while len(self._previews) > MAX_PREVIEWS:
                self._previews.popitem(last=False)
        return {"status": "ok", "previewId": pid, "scope": scope, "requestedScope": requested,
                "requiresConsent": scope == "whole-definition", "limits": dict(self._limits), **view}

    # -- payload ---------------------------------------------------------------------------------
    def _compose(self, project: str, pins: dict[str, dict[str, Any]], scope: str, snapshots: dict[str, Snapshot],
                 excluded: list[dict[str, Any]], rules: list[dict[str, Any]],
                 missing: list[dict[str, Any]]) -> dict[str, Any]:
        """One snapshot section per readable pinned document (limits per document), the bridges that could not be read
        listed as ``excluded``, the 256 KiB cap on the whole body (D-29)."""
        max_objects, max_params, max_bytes = (self._limits["max_objects"], self._limits["max_parameters"],
                                              self._limits["max_bytes"])
        truncation: list[dict[str, Any]] = [{"app": app, **entry} for app, snap in snapshots.items()
                                            for entry in snap.source_truncation]
        # rules
        kept_rules = [{"ruleId": r["ruleId"], "text": r["text"][:RULE_TEXT_LIMIT]} for r in rules[:RULE_LIMIT]]
        if len(rules) > RULE_LIMIT:
            truncation.append({"what": "rules", "kept": len(kept_rules), "total": len(rules)})
        # objects and parameters, per document
        objects: dict[str, list[dict[str, Any]]] = {}
        totals: dict[str, int] = {}
        for app, snap in snapshots.items():
            params_total = params_kept = 0
            totals[app] = snap.total_objects if snap.total_objects is not None else len(snap.objects)
            kept: list[dict[str, Any]] = []
            for obj in snap.objects[:max_objects]:
                listed = obj.get(snap.params_key)
                listed = listed if isinstance(listed, list) else []
                host_total = obj.get("parametersTotal") if isinstance(obj.get("parametersTotal"), int) else len(listed)
                params_total += max(host_total, len(listed))
                trimmed = listed[:max_params]
                params_kept += len(trimmed)
                copy = dict(obj)
                if snap.params_key in copy:
                    copy[snap.params_key] = trimmed
                kept.append(copy)
            objects[app] = kept
            if params_kept < params_total:
                truncation.append({"app": app, "what": "parameters", "kept": params_kept, "total": params_total})
        docs = [d for app in pins if (d := _doc_info(pins[app]))]
        read_docs = [d for d in docs if d["app"] in snapshots]

        def snapshot_body(app: str, n: int) -> dict[str, Any]:
            snap = snapshots[app]
            body: dict[str, Any] = {"app": app}
            definition = snap.extras.get("definition")
            if definition is not None:
                body["definition"] = definition
            body[_OBJECTS_KEY.get(app, "objects")] = objects[app][:n]
            ids = {str(o.get("instanceId", "")).lower() for o in objects[app][:n]}
            wires = snap.extras.get("wires")
            if isinstance(wires, list):
                body["wires"] = [w for w in wires if str(w.get("fromNode", "")).lower() in ids
                                 and str(w.get("toNode", "")).lower() in ids]
            if snap.scope == "whole-definition":
                body["object"] = snap.extras.get("object")
                body["algorithms"] = snap.extras.get("algorithms") or []
            return body

        def counts(cap: int | None) -> dict[str, int]:
            return {app: len(objs) if cap is None else min(len(objs), cap) for app, objs in objects.items()}

        def object_entries(kept: dict[str, int]) -> list[dict[str, Any]]:
            return [{"app": app, "what": "objects", "kept": kept[app], "total": totals[app]}
                    for app in snapshots if kept[app] < totals[app]]

        def render(kept: dict[str, int], rule_list: list[dict[str, Any]], structure: bool = True) -> str:
            sections = []
            for app in snapshots:
                section = snapshot_body(app, kept[app])
                if not structure:
                    for key in ("algorithms", "object", "wires"):
                        section.pop(key, None)
                sections.append(section)
            body = {"project": project, "scope": scope, "documents": docs, "excluded": excluded, "rules": rule_list,
                    "fragments": [], "snapshots": sections, "truncation": truncation + object_entries(kept),
                    "missing": missing}
            names = "; ".join(f"{_line(d['name'])} [{d['app']}]" for d in docs) if docs else "(none)"
            head = f"DeGram context (scope: {scope})\nproject: {_line(project)}\ndocuments: {names}\n"
            return head + json.dumps(body, ensure_ascii=True, separators=(",", ":"))

        def fits(kept: dict[str, int], rule_list: list[dict[str, Any]]) -> bool:
            return len(render(kept, rule_list).encode("utf-8")) <= max_bytes

        kept_counts = counts(None)
        payload = render(kept_counts, kept_rules)
        full_bytes = len(payload.encode("utf-8"))
        if full_bytes > max_bytes:
            if fits(counts(0), kept_rules):
                # largest per-document object cap whose payload fits, rules and structure kept
                lo, hi = 0, max((len(o) for o in objects.values()), default=0)
                while lo < hi:
                    mid = (lo + hi + 1) // 2
                    if fits(counts(mid), kept_rules):
                        lo = mid
                    else:
                        hi = mid - 1
                kept_counts = counts(lo)
                payload = render(kept_counts, kept_rules)
            else:  # the rules and structure alone are too big: give up structure, then rules
                kept_counts = counts(0)
                payload = render(kept_counts, kept_rules, structure=False)
                if len(payload.encode("utf-8")) > max_bytes:
                    missing.append({"what": "rules", "reason": "PAYLOAD_TOO_LARGE"})
                    kept_rules = []
                    payload = render(kept_counts, kept_rules, structure=False)
        final_bytes = len(payload.encode("utf-8"))
        shown = truncation + object_entries(kept_counts)
        if final_bytes < full_bytes:
            shown = shown + [{"what": "bytes", "kept": final_bytes, "total": full_bytes}]
        summary_docs = []
        for d in read_docs:
            app = d["app"]
            snap = snapshots[app]
            kept_params = sum(len(o.get(snap.params_key) or []) for o in objects[app][:kept_counts[app]])
            summary_docs.append({
                "app": app, "name": d["name"], "path": d["path"], "objects": kept_counts[app], "parameters": kept_params,
                "truncated": any(t.get("app") == app for t in shown), "emptySelection": bool(snap.empty_selection)})
        summary = {"project": project, "documents": summary_docs, "rules": len(kept_rules), "fragments": 0,
                   "bytes": final_bytes, "excluded": excluded}
        return {"payload": payload, "summary": summary, "truncation": shown, "missing": missing, "documents": docs,
                "_snapshots": [snapshot_body(app, kept_counts[app]) for app in snapshots]}

    # -- agent tool ------------------------------------------------------------------------------
    def agent_snapshot(self, cancel: CancelToken | None = None) -> dict[str, Any]:
        """The current selection of every pinned document, bounded exactly like a preview, for the agent tool
        ``degram_document_snapshot``. Selection scope only: whole-definition goes through the context card and its
        consent, never through a tool call. A bridge that cannot be read is listed in ``excluded``; when none can be
        read the first outcome is raised as ``BridgeError`` (no pin, identity, bridge outcomes)."""
        try:
            info = _credentials.require_info()
        except DegramCredentialsError as exc:
            raise BridgeError(exc.code, None, str(exc).split(": ", 1)[-1]) from exc
        pins = self._documents.pinned
        if not pins:
            raise BridgeError(DOCUMENT_NOT_OPEN, "NO_DOCUMENT_PINNED", "No document is pinned. Ask the user to select one.")
        results = self._documents.read_snapshots("selection", info.project, cancel)
        snapshots, excluded = _split_results(pins, results)
        if not snapshots:
            raise next(r for r in results.values() if isinstance(r, BridgeError))
        view = self._compose(info.project, pins, "selection", snapshots, excluded, [],
                             [m for snap in snapshots.values() for m in snap.missing])
        return {"status": "ok", "scope": "selection", "documents": view["documents"], "summary": view["summary"],
                "truncation": view["truncation"], "missing": view["missing"], "excluded": excluded,
                "snapshots": view["_snapshots"]}

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
