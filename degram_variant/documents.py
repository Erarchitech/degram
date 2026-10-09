"""Open documents of every reachable CAD bridge, and the pinned document of each bridge (1301 D-13, D-29).

``list`` asks each bridge for its open documents (GH: ``get_document_identity``; Revit: ``list_open_documents``) and
reports a state per bridge (the UI-SPEC bridge states). Nothing is pinned until ``pin`` is called, a single open document
is never pinned automatically, and every snapshot read goes through a source that first re-checks the pinned identity
(``IDENTITY_MISMATCH`` / ``DOCUMENT_NOT_OPEN`` instead of reading another document).

D-29 (1301-21, G-13): one pin per bridge. Pinning a document replaces only that bridge's pin, so a Revit model and a
Grasshopper definition are pinned at the same time; ``read_snapshots`` reads every pinned bridge independently and a
failure of one bridge is that bridge's outcome, never the other's."""

from __future__ import annotations

import contextvars
import threading
from collections.abc import Mapping
from typing import Any, Protocol

from .cancel import CancelToken
from .outcomes import DOCUMENT_NOT_OPEN, BridgeError, bridge_state
from .snapshot import Snapshot


class DocumentSource(Protocol):
    app: str

    def list_documents(self, cancel: CancelToken | None = None) -> list[dict[str, Any]]: ...

    def read_snapshot(self, pinned: dict[str, Any], scope: str, project: str,
                      cancel: CancelToken | None = None, deadline_s: float | None = None) -> Snapshot: ...


def _same_identity(app: str, a: dict[str, Any], b: dict[str, Any]) -> bool:
    if app == "grasshopper":
        return bool(a.get("documentId")) and a.get("documentId") == b.get("documentId")
    if app == "revit":
        return bool(a.get("creationGuid")) and a.get("creationGuid") == b.get("creationGuid") \
            and (a.get("pathName") or "") == (b.get("pathName") or "")
    return False


class DocumentsService:
    def __init__(self, sources: dict[str, DocumentSource]) -> None:
        self._sources = dict(sources)
        self._lock = threading.Lock()
        self._pins: dict[str, dict[str, Any]] = {}
        self._generation = 0

    @property
    def apps(self) -> tuple[str, ...]:
        return tuple(self._sources)

    @property
    def pinned(self) -> dict[str, dict[str, Any]]:
        """The pinned documents keyed by bridge app, in the order of the bridges (empty when nothing is pinned)."""
        with self._lock:
            return {app: dict(self._pins[app]) for app in self._sources if app in self._pins}

    @property
    def generation(self) -> int:
        with self._lock:
            return self._generation

    def source(self, app: str) -> DocumentSource:
        if app not in self._sources:
            raise ValueError(f"unknown CAD application {app!r} (expected one of {sorted(self._sources)})")
        return self._sources[app]

    # -- picker ----------------------------------------------------------------------------------
    def list(self, cancel: CancelToken | None = None, app: str | None = None) -> dict[str, Any]:
        """Open documents per bridge. ``app`` limits the listing to one bridge (the picker loads each group on its
        own); an unknown name raises ``ValueError`` like ``source``."""
        groups = []
        pinned = self.pinned
        sources = {app: self.source(app)} if app is not None else self._sources
        for app, source in sources.items():
            group: dict[str, Any] = {"app": app, "state": "ready", "documents": []}
            try:
                documents = source.list_documents(cancel)
            except BridgeError as exc:
                if exc.code == "CANCELLED":
                    raise
                code, reason = exc.code, exc.reason
                state = bridge_state(code, reason)
                if code == DOCUMENT_NOT_OPEN:  # nothing open to pick is a setup state, not a mismatch
                    state, reason = "setup-incomplete", "NO_DOCUMENT_OPEN"
                group.update({"state": state or "off", "code": code, "message": exc.message})
                if reason:
                    group["reason"] = reason
                groups.append(group)
                continue
            for doc in documents:
                doc["pinned"] = bool(app in pinned and _same_identity(app, pinned[app]["identity"], doc["identity"]))
            group["documents"] = documents
            if any(d["pinned"] for d in documents):
                group["state"] = "pinned"
            groups.append(group)
        return {"groups": groups, "pinned": pinned}

    def status(self, cancel: CancelToken | None = None) -> dict[str, Any]:
        """One line per bridge (state, code, reason, number of open documents) and the pinned documents."""
        listing = self.list(cancel)
        bridges = []
        for group in listing["groups"]:
            line: dict[str, Any] = {"app": group["app"], "state": group["state"],
                                    "documents": len(group["documents"])}
            for key in ("code", "reason", "message"):
                if group.get(key):
                    line[key] = group[key]
            bridges.append(line)
        return {"status": "ok", "bridges": bridges, "pinned": listing["pinned"]}

    def pin(self, app: str, identity: dict[str, Any], cancel: CancelToken | None = None) -> dict[str, Any]:
        """Pin an open document; it replaces only this bridge's pin (D-29). The document must be in the bridge's fresh
        list: a stale picker row cannot pin a document that is gone. Raises ValueError for an unknown app,
        ``BridgeError`` when the document is not open."""
        source = self.source(app)
        if not isinstance(identity, dict) or not identity:
            raise ValueError("identity is required")
        match = next((d for d in source.list_documents(cancel) if _same_identity(app, identity, d["identity"])), None)
        if match is None:
            raise BridgeError(DOCUMENT_NOT_OPEN, "NOT_IN_OPEN_DOCUMENTS",
                              "That document is not open in the host any more; nothing was pinned.")
        pinned = {"app": app, "name": match["name"], "path": match["path"], "unsaved": match["unsaved"],
                  "identity": dict(match["identity"])}
        with self._lock:
            self._pins[app] = pinned
            self._generation += 1
        return dict(pinned)

    def unpin(self, app: str) -> None:
        """Forget one bridge's pin (the other bridge keeps its own). ValueError for an unknown app."""
        self.source(app)
        with self._lock:
            self._pins.pop(app, None)
            self._generation += 1

    def unpin_all(self) -> None:
        with self._lock:
            self._pins.clear()
            self._generation += 1

    # -- reads -----------------------------------------------------------------------------------
    def read_snapshots(self, scope: str, project: str, cancel: CancelToken | None = None,
                       deadline_s: Mapping[str, float] | None = None) -> dict[str, Snapshot | BridgeError]:
        """One result per pinned bridge: its snapshot, or the ``BridgeError`` that ended that bridge's read (identity
        mismatch, closed document, BUSY, setup...). Every source re-checks its pinned identity first. The bridges are
        read concurrently, each with its own deadline from ``deadline_s`` (the preview path; absent keeps the source's own
        tool deadline), so one slow bridge never spends the other's budget. Whole-definition scope applies to the
        Grasshopper definition only: any other bridge contributes its selection. A cancelled read raises
        ``CANCELLED`` for the whole request."""
        pins = self.pinned
        results: dict[str, Snapshot | BridgeError] = {}
        raised: dict[str, BaseException] = {}

        def read(app: str) -> None:
            app_scope = "whole-definition" if scope == "whole-definition" and app == "grasshopper" else "selection"
            wait = (deadline_s or {}).get(app)
            try:
                source = self._sources[app]
                if wait is None:
                    results[app] = source.read_snapshot(pins[app], app_scope, project, cancel)
                else:
                    results[app] = source.read_snapshot(pins[app], app_scope, project, cancel, deadline_s=wait)
            except BridgeError as exc:
                results[app] = exc
            except BaseException as exc:  # noqa: BLE001 - re-raised on the caller's thread below
                raised[app] = exc

        if len(pins) == 1:
            read(next(iter(pins)))
        elif pins:
            threads = [threading.Thread(target=contextvars.copy_context().run, args=(read, app),
                                        name=f"degram-read-{app}", daemon=True) for app in pins]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        for exc in raised.values():
            raise exc
        for outcome in results.values():
            if isinstance(outcome, BridgeError) and outcome.code == "CANCELLED":
                raise outcome
        return {app: results[app] for app in pins}

    def reset(self) -> None:
        """Scope change or sign-out (D-08): forget every pinned document."""
        self.unpin_all()
