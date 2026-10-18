"""The mapping sessions of the bound project and the Grasshopper canvas actions behind DeGram's «Модели → Mapping»
sub-tab (Phase 1303-10; contract ``.planning/phases/1303-pravilo-gh-obekt/1303-API-CONTRACT.md`` §2, §3, §7).

DG owns the sessions, their proposals and answers (``dg_client``: delegated token, bound project only); the
Grasshopper CONNECTOR owns starting a session from the canvas, and the canvas owns focusing a component
(``gh_bridge``). This module only routes, filters the session list by document and trims what the panel does not
read. Nothing here creates or applies a session on DG directly.

A Grasshopper document is matched by its *document key*: the file name without its extension, lower-cased, every
character that is not a letter, a digit, ``-`` or ``_`` replaced by ``-`` (``MappingCanvasReader.DocumentKey`` in
DG.gha). The bridge's ``get_mapping_status`` names the key of the open definition; when the bridge cannot answer the
key is derived from the document name the same way. A session row without ``document`` (an older row) is matched by
its label before « · »."""

from __future__ import annotations

import re
from typing import Any

from .cancel import CancelToken
from .dg_client import DgClient
from .gh_bridge import GhBridgeClient
from .outcomes import CANCELLED, SETUP_INCOMPLETE, BridgeError

# The per-element and per-group engine detail of a session; the panel reads summary, questions, answers and llm.
PANEL_DROPPED_KEYS = ("elements", "groups", "parameters", "measures")
SESSION_ROW_KEYS = ("sessionId", "label", "document", "platform", "createdAt", "summary", "appliedAt")
_EXTENSIONS = (".ghx", ".gh", ".rvt")
_COMPONENT_ID = re.compile(r"^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$")
_MAX_ID = 512


def document_key(name: Any) -> str:
    """The document key of a file or document name (``Tower Facade.gh`` -> ``tower-facade``)."""
    text = str(name or "").strip()
    for ext in _EXTENSIONS:
        if text.lower().endswith(ext):
            text = text[: -len(ext)]
            break
    return "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in text.strip().lower())


def session_document(row: dict[str, Any]) -> str:
    """The document key a session row belongs to: its ``document``, else its label before « · »."""
    document = row.get("document")
    if isinstance(document, str) and document:
        return document_key(document)
    label = str(row.get("label") or "")
    return document_key(label.split(" · ", 1)[0]) if " · " in label else ""


def _require_id(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > _MAX_ID:
        raise ValueError(f"{field} is required")
    return value


def _group_ids(value: Any) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
        raise ValueError("groupIds must be a list of group ids")
    return list(value)


def panel_session(session: dict[str, Any]) -> dict[str, Any]:
    """The session as the panel reads it: everything but the per-element and per-group detail."""
    return {k: v for k, v in session.items() if k not in PANEL_DROPPED_KEYS}


class MappingService:
    def __init__(self, dg: DgClient, gh: GhBridgeClient) -> None:
        self._dg = dg
        self._gh = gh

    # -- DG ------------------------------------------------------------------------------------------
    def sessions(self, document: Any = None, app: Any = None, cancel: CancelToken | None = None) -> dict[str, Any]:
        """The project's sessions (newest first, at most ``MAPPING_SESSIONS_LIMIT``), only those of ``document`` when
        it is given. For ``app == "grasshopper"`` the key comes from the canvas (``get_mapping_status``) first; the
        answer then also carries what CONNECTOR reports (``connector``, ``signedIn``, ``connectorSessionId``,
        ``connectorMessage``)."""
        if document is not None and not isinstance(document, str):
            raise ValueError("document must be a document name")
        if app not in (None, "grasshopper", "revit"):
            raise ValueError(f"unknown CAD application {app!r}")
        out: dict[str, Any] = {}
        key = document_key(document) if document else None
        if document and app == "grasshopper":
            status = self._mapping_status(cancel)
            if status is not None:
                bridge_key = status.get("document")
                if isinstance(bridge_key, str) and bridge_key:
                    key = bridge_key
                out.update({"connector": bool(status.get("connector")), "signedIn": bool(status.get("signedIn")),
                            "connectorSessionId": status.get("sessionId") if isinstance(status.get("sessionId"), str)
                            else None,
                            "connectorMessage": str(status.get("message") or "") or None})
        rows = self._dg.list_mapping_sessions(cancel)
        if key is not None:
            rows = [r for r in rows if session_document(r) == document_key(key)]
        out["document"] = key
        out["sessions"] = [{k: r[k] for k in SESSION_ROW_KEYS if r.get(k) is not None} for r in rows]
        return out

    def session(self, session_id: Any, cancel: CancelToken | None = None) -> dict[str, Any]:
        return panel_session(self._dg.get_mapping_session(_require_id(session_id, "sessionId"), cancel))

    def answer(self, session_id: Any, question_id: Any, option_id: Any, group_ids: Any = None,
               cancel: CancelToken | None = None) -> dict[str, Any]:
        return panel_session(self._dg.post_mapping_decision(
            _require_id(session_id, "sessionId"), _require_id(question_id, "questionId"),
            _require_id(option_id, "optionId"), _group_ids(group_ids), cancel))

    def undo(self, session_id: Any, answer_id: Any, cancel: CancelToken | None = None) -> dict[str, Any]:
        return panel_session(self._dg.undo_mapping_answer(
            _require_id(session_id, "sessionId"), _require_id(answer_id, "answerId"), cancel))

    # -- Grasshopper canvas -----------------------------------------------------------------------------
    def _mapping_status(self, cancel: CancelToken | None) -> dict[str, Any] | None:
        """``get_mapping_status`` of the open definition, or None when the bridge cannot answer (the caller then
        derives the key from the document name). A cancel still ends the whole request."""
        try:
            status = self._gh.call("get_mapping_status", {}, cancel=cancel)
        except BridgeError as exc:
            if exc.code == CANCELLED:
                raise
            return None
        return status if isinstance(status, dict) else None

    def start(self, cancel: CancelToken | None = None) -> dict[str, Any]:
        """CONNECTOR reads the canvas and creates a session now (``start_mapping``)."""
        reply = self._gh.call("start_mapping", {}, cancel=cancel)
        if not isinstance(reply, dict):
            raise BridgeError(SETUP_INCOMPLETE, "BRIDGE_PROTOCOL", "start_mapping returned no result.")
        return {"started": reply.get("started") is True, "message": str(reply.get("message") or "") or None}

    def focus(self, component_id: Any, cancel: CancelToken | None = None) -> dict[str, Any]:
        """Bring the Grasshopper editor forward, select the component and zoom to it (``focus_component``)."""
        if not isinstance(component_id, str) or not _COMPONENT_ID.match(component_id):
            raise ValueError("componentId must be a Grasshopper instance id")
        reply = self._gh.call("focus_component", {"componentId": component_id}, cancel=cancel)
        if not isinstance(reply, dict):
            raise BridgeError(SETUP_INCOMPLETE, "BRIDGE_PROTOCOL", "focus_component returned no result.")
        name = reply.get("name")
        return {"found": reply.get("found") is True, "componentId": component_id,
                "name": name if isinstance(name, str) and name else None}
