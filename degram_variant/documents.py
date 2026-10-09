"""Open documents of every reachable CAD bridge, and the one pinned document (1301 D-13).

``list`` asks each bridge for its open documents (GH: ``get_document_identity``; Revit: ``list_open_documents``) and
reports a state per bridge (the UI-SPEC bridge states). Nothing is pinned until ``pin`` is called, a single open document
is never pinned automatically, and every snapshot read goes through a source that first re-checks the pinned identity
(``IDENTITY_MISMATCH`` / ``DOCUMENT_NOT_OPEN`` instead of reading another document)."""

from __future__ import annotations

import threading
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
        self._pinned: dict[str, Any] | None = None
        self._generation = 0

    @property
    def apps(self) -> tuple[str, ...]:
        return tuple(self._sources)

    @property
    def pinned(self) -> dict[str, Any] | None:
        with self._lock:
            return dict(self._pinned) if self._pinned else None

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
                doc["pinned"] = bool(pinned and pinned["app"] == app and _same_identity(app, pinned["identity"], doc["identity"]))
            group["documents"] = documents
            if any(d["pinned"] for d in documents):
                group["state"] = "pinned"
            groups.append(group)
        return {"groups": groups, "pinned": pinned}

    def status(self, cancel: CancelToken | None = None) -> dict[str, Any]:
        """One line per bridge (state, code, reason, number of open documents) and the pinned document."""
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
        """Pin an open document. The document must be in the bridge's fresh list: a stale picker row cannot pin a
        document that is gone. Raises ValueError for an unknown app, ``BridgeError`` when the document is not open."""
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
            self._pinned = pinned
            self._generation += 1
        return dict(pinned)

    def unpin(self) -> None:
        with self._lock:
            self._pinned = None
            self._generation += 1

    # -- reads -----------------------------------------------------------------------------------
    def read_snapshot(self, scope: str, project: str, cancel: CancelToken | None = None,
                      deadline_s: float | None = None) -> Snapshot | None:
        """The pinned document's snapshot, or None when nothing is pinned. The source re-checks the identity first.
        ``deadline_s`` (the preview path) bounds the bridge wait; None keeps the source's own tool deadline."""
        pinned = self.pinned
        if pinned is None:
            return None
        source = self._sources[pinned["app"]]
        if deadline_s is None:
            return source.read_snapshot(pinned, scope, project, cancel)
        return source.read_snapshot(pinned, scope, project, cancel, deadline_s=deadline_s)

    def reset(self) -> None:
        """Scope change or sign-out (D-08): forget the pinned document."""
        self.unpin()
