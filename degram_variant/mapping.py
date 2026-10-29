"""The mapping sessions of the bound project and the CAD actions behind DeGram's «Модели → Mapping» sub-tab
(Phase 1303-10, 1303-13; contract ``.planning/phases/1303-pravilo-gh-obekt/1303-API-CONTRACT.md`` §2, §3, §7, §8).

DG owns the sessions, their proposals and answers (``dg_client``: delegated token, bound project only). Starting a
session and showing its items belong to the CAD side: in Grasshopper the CONNECTOR starts from the canvas and the
canvas focuses a component (``gh_bridge``); in Revit the DG Revit connector starts from the active model
(``dg_start_mapping``) and selects and zooms a group's elements (``dg_show_elements``) through the Revit MCP child
(``revit_bridge``, D-47, D-51). This module only routes, filters the session list by document and trims what the panel
does not read. Only the shared confirmation button sends explicit accepted-answer batch intent to DG; existing
server permissions still apply. Nothing here creates a DG session or writes to CAD directly.

A document is matched by its *document key*: the file name without its extension, lower-cased, every character that
is not a letter, a digit, ``-`` or ``_`` replaced by ``-`` (``MappingCanvasReader.DocumentKey`` in DG.gha; the Revit
connector keys the ``.rvt`` name the same way, D-48). The Grasshopper bridge's ``get_mapping_status`` names the key of
the open definition; when it cannot answer, and always for Revit, the key is derived from the document name. A session
row without ``document`` (an older row) is matched by its label before « · »."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from .cancel import CancelToken
from .dg_client import DgClient
from .gh_bridge import GhBridgeClient
from .outcomes import CANCELLED, SETUP_INCOMPLETE, BridgeError

if TYPE_CHECKING:
    from .revit_bridge import RevitBridgeClient

APPS = ("grasshopper", "revit")
# The per-element and per-group engine detail of a session; the panel reads summary, questions, answers and llm.
PANEL_DROPPED_KEYS = ("elements", "groups", "parameters", "measures")
SESSION_ROW_KEYS = ("sessionId", "label", "document", "platform", "createdAt", "summary", "appliedAt")
_EXTENSIONS = (".ghx", ".gh", ".rvt")
_COMPONENT_ID = re.compile(r"^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$")
_MAX_ID = 512
# One Revit mapping session holds at most this many elements, and dg_show_elements takes at most as many ids (§8.3).
MAX_SHOW_ELEMENTS = 5000
# The connector status rides on the session list: a blocked Revit must not hold the list past the renderer's RPC
# timeout, so the status read gives up early (BUSY) and the list is answered without it.
REVIT_STATUS_DEADLINE_S = 10.0


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


def _app(value: Any, default: str | None) -> str | None:
    if value is None:
        return default
    if value not in APPS:
        raise ValueError(f"unknown CAD application {value!r}")
    return value


def panel_session(session: dict[str, Any]) -> dict[str, Any]:
    """The session as the panel reads it: everything but the per-element and per-group detail."""
    out = {k: v for k, v in session.items() if k not in PANEL_DROPPED_KEYS}
    if isinstance(out.get("batches"), list):
        out["batches"] = [{k: v for k, v in batch.items() if k != "payload"}
                          for batch in out["batches"] if isinstance(batch, dict)]
    return out


def _connector_fields(status: dict[str, Any], connector: bool) -> dict[str, Any]:
    """What CONNECTOR (Grasshopper) or the DG Revit connector reports about itself, as the sessions answer names it."""
    session_id = status.get("sessionId")
    message = status.get("connectorMessage") or status.get("message")
    return {"connector": connector, "signedIn": status.get("signedIn") is True,
            "connectorSessionId": session_id if isinstance(session_id, str) and session_id else None,
            "connectorMessage": str(message or "") or None}


def _group_native_ids(session: dict[str, Any], group_id: str) -> list[str]:
    """The ``nativeId`` (Revit UniqueId) of every element of one group, in session order, without repeats."""
    ids: list[str] = []
    seen: set[str] = set()
    for element in session.get("elements") or []:
        if not isinstance(element, dict) or element.get("groupId") != group_id:
            continue
        native = element.get("nativeId")
        if isinstance(native, str) and native and native not in seen:
            seen.add(native)
            ids.append(native)
            if len(ids) == MAX_SHOW_ELEMENTS:
                break
    return ids


def _count(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    return value if isinstance(value, int) and value > 0 else 0


class MappingService:
    def __init__(self, dg: DgClient, gh: GhBridgeClient, revit: RevitBridgeClient | None = None) -> None:
        if revit is None:
            from .revit_bridge import RevitBridgeClient

            revit = RevitBridgeClient()
        self._dg = dg
        self._gh = gh
        self._revit = revit

    # -- DG ------------------------------------------------------------------------------------------
    def sessions(self, document: Any = None, app: Any = None, cancel: CancelToken | None = None) -> dict[str, Any]:
        """The project's sessions (newest first, at most ``MAPPING_SESSIONS_LIMIT``), only those of ``document`` when
        it is given. For ``app == "grasshopper"`` the key comes from the canvas (``get_mapping_status``) first; for
        ``app == "revit"`` it is the key of the document name. With a document the answer also carries what the
        connector reports (``connector``, ``signedIn``, ``connectorSessionId``, ``connectorMessage``); a connector that
        cannot answer leaves them out and the sessions are still listed."""
        if document is not None and not isinstance(document, str):
            raise ValueError("document must be a document name")
        app = _app(app, None)
        out: dict[str, Any] = {}
        key = document_key(document) if document else None
        if document and app == "grasshopper":
            status = self._mapping_status(cancel)
            if status is not None:
                bridge_key = status.get("document")
                if isinstance(bridge_key, str) and bridge_key:
                    key = bridge_key
                out.update(_connector_fields(status, bool(status.get("connector"))))
        elif document and app == "revit":
            status = self._revit_status(cancel)
            if status is not None:
                out.update(_connector_fields(status, True))  # it answered, so the connector is loaded in Revit
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

    def apply(self, session_id: Any, request_id: Any, revision: Any, answer_ids: Any,
              cancel: CancelToken | None = None) -> dict[str, Any]:
        session_id = _require_id(session_id, "sessionId")
        if not isinstance(request_id, str) or not 3 <= len(request_id) <= 64:
            raise ValueError("requestId must have 3 to 64 characters")
        if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{24}", revision):
            raise ValueError("revision must be the current 24-character revision")
        if (not isinstance(answer_ids, list) or not answer_ids or len(answer_ids) > 5000
                or not all(isinstance(v, str) and v.strip() and len(v) <= _MAX_ID for v in answer_ids)
                or len(set(answer_ids)) != len(answer_ids)):
            raise ValueError("answerIds must be a nonempty list of unique answer ids")
        batch = self._dg.commit_mapping(session_id, request_id, revision, sorted(answer_ids), cancel)
        # Do not turn a successful commit into a failure if a subsequent session read fails.
        return {k: batch[k] for k in ("batchId", "revision", "answerIds", "committedAt", "delivery") if k in batch}

    # -- CAD side: start and show ---------------------------------------------------------------------
    def start(self, app: Any = "grasshopper", cancel: CancelToken | None = None) -> dict[str, Any]:
        """Create a session from the CAD model now: CONNECTOR reads the canvas (``start_mapping``), or the DG Revit
        connector reads the active model's scope (``dg_start_mapping``, which also answers the new ``sessionId``)."""
        if _app(app, "grasshopper") == "revit":
            reply = self._revit.call("dg_start_mapping", {}, cancel=cancel)
            session_id = reply.get("sessionId")
            # scope "selection": only the elements selected in Revit were read (D-48); DeGram warns about it (F-10)
            result = {"started": reply.get("started") is True,
                      "sessionId": session_id if isinstance(session_id, str) and session_id else None,
                      "message": str(reply.get("message") or "") or None}
            if reply.get("scope") in ("selection", "view"):
                result["scope"] = reply["scope"]
            read = reply.get("read")
            if isinstance(read, int) and not isinstance(read, bool) and read >= 0:
                result["read"] = read
            return result
        reply = self._gh.call("start_mapping", {}, cancel=cancel)
        if not isinstance(reply, dict):
            raise BridgeError(SETUP_INCOMPLETE, "BRIDGE_PROTOCOL", "start_mapping returned no result.")
        return {"started": reply.get("started") is True, "message": str(reply.get("message") or "") or None}

    def focus(self, component_id: Any = None, app: Any = "grasshopper", session_id: Any = None, item_id: Any = None,
              cancel: CancelToken | None = None) -> dict[str, Any]:
        """Show one item in its CAD application. Grasshopper: bring the editor forward, select the component and zoom
        to it (``focus_component``). Revit: resolve the group ``item_id`` of session ``session_id`` to its elements'
        UniqueIds from the full DG session and let the connector select them and zoom the active view
        (``dg_show_elements``, D-51); a group without elements answers ``found: false`` without calling Revit."""
        if _app(app, "grasshopper") == "revit":
            return self._show_revit_group(_require_id(session_id, "sessionId"), _require_id(item_id, "itemId"),
                                          cancel)
        if not isinstance(component_id, str) or not _COMPONENT_ID.match(component_id):
            raise ValueError("componentId must be a Grasshopper instance id")
        reply = self._gh.call("focus_component", {"componentId": component_id}, cancel=cancel)
        if not isinstance(reply, dict):
            raise BridgeError(SETUP_INCOMPLETE, "BRIDGE_PROTOCOL", "focus_component returned no result.")
        name = reply.get("name")
        return {"found": reply.get("found") is True, "componentId": component_id,
                "name": name if isinstance(name, str) and name else None}

    def _show_revit_group(self, session_id: str, item_id: str, cancel: CancelToken | None) -> dict[str, Any]:
        unique_ids = _group_native_ids(self._dg.get_mapping_session(session_id, cancel), item_id)
        if not unique_ids:
            return {"found": False, "shown": 0, "missing": [], "itemId": item_id}
        reply = self._revit.call("dg_show_elements", {"unique_ids": unique_ids}, cancel=cancel)
        missing = reply.get("missing")
        found = _count(reply.get("found"))  # the connector counts the elements it found in the model
        return {"found": found > 0, "shown": _count(reply.get("shown")),
                "missing": [m for m in missing if isinstance(m, str)] if isinstance(missing, list) else [],
                "itemId": item_id}

    # -- connector status -------------------------------------------------------------------------------
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

    def _revit_status(self, cancel: CancelToken | None) -> dict[str, Any] | None:
        """``dg_mapping_status`` of the DG Revit connector, or None when it cannot answer (adapter not connected,
        Revit busy or off). A cancel still ends the whole request."""
        try:
            return self._revit.call("dg_mapping_status", {}, cancel=cancel, deadline_s=REVIT_STATUS_DEADLINE_S)
        except BridgeError as exc:
            if exc.code == CANCELLED:
                raise
            return None
