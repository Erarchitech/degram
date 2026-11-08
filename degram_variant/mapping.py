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

import json
import os
import re
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .cancel import CancelToken
from .dg_client import DgClient
from .gh_bridge import GhBridgeClient
from .outcomes import CANCELLED, DG_UNAVAILABLE, SETUP_INCOMPLETE, BridgeError

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
# DG 1303-33 (D-123, D-124): the Revit mapping filters (View, Selection, Categories, intersected), the element limit
# per session (the stand engine's cap) and the continuation after an over-limit start.
MAX_FILTER_CATEGORIES = 200
MAX_START_LIMIT = 5000
_CATEGORY_NAME = re.compile(r"^OST_[A-Za-z0-9_]+$")
_START_SCOPES = ("selection", "view", "filters")
_START_COUNTS = ("read", "matched", "remaining", "lastElementId")
# DG 1303-33 (D-121): the answer ids the agent proposed, per project and session, in the scope profile home.
AGENT_ANSWERS_FILE = "degram-agent-answers.json"
MAX_AGENT_SESSIONS = 200


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


def _start_arguments(filters: Any, limit: Any, after: Any) -> dict[str, Any]:
    """D-123/D-124: the dg_start_mapping arguments of a filtered Revit start; ``{}`` keeps the connector's default
    (the selection, else the active view). ``filters`` = {view?: "active" | name | id, selection?: bool,
    categories?: [OST_*]}; ``{}`` reads the whole model."""
    if filters is None:
        if limit is not None or after is not None:
            raise ValueError("limit and after go with filters ({} reads the whole model)")
        return {}
    if not isinstance(filters, dict) or set(filters) - {"view", "selection", "categories"}:
        raise ValueError("filters may hold only view, selection and categories")
    clean: dict[str, Any] = {}
    view = filters.get("view")
    if view is not None:
        if isinstance(view, bool) or not (view == "active" or (isinstance(view, int) and view > 0)
                                          or (isinstance(view, str) and view.strip())):
            raise ValueError('filters.view must be "active", a view name or a view id')
        clean["view"] = view.strip() if isinstance(view, str) else view
    if filters.get("selection") not in (None, False, True):
        raise ValueError("filters.selection must be true or false")
    if filters.get("selection") is True:
        clean["selection"] = True
    categories = filters.get("categories")
    if categories is not None:
        if not isinstance(categories, list) or not categories:
            raise ValueError('filters.categories must be a non-empty list such as ["OST_Rooms"]')
        names: list[str] = []
        for item in categories:
            text = item.strip() if isinstance(item, str) else ""
            if not _CATEGORY_NAME.match(text):
                raise ValueError("every category must be a Revit BuiltInCategory name such as OST_Rooms")
            if text not in names:
                names.append(text)
        if len(names) > MAX_FILTER_CATEGORIES:
            raise ValueError(f"filters.categories names more than {MAX_FILTER_CATEGORIES} categories")
        clean["categories"] = names
    arguments: dict[str, Any] = {"filters": clean}
    if limit is not None:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_START_LIMIT:
            raise ValueError(f"limit must be a whole number from 1 to {MAX_START_LIMIT}")
        arguments["limit"] = limit
    if after is not None:
        if isinstance(after, bool) or not isinstance(after, int) or after < 0:
            raise ValueError("after must be the lastElementId of the previous start")
        arguments["after"] = after
    return arguments


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


def latest_answer_id(session: dict[str, Any], question_id: str) -> str | None:
    """The id of the newest answer to ``question_id`` in a recomputed session (the one just posted)."""
    rows = [a for a in session.get("answers") or [] if isinstance(a, dict) and a.get("questionId") == question_id
            and isinstance(a.get("answerId"), str)]
    return max(rows, key=lambda a: str(a.get("decidedAt") or ""))["answerId"] if rows else None


class AgentAnswers:
    """D-121: which answers the agent proposed. DG records every answer under the user's principal, so DeGram keeps
    the agent's own ids, per project and session, in the scope profile home (resolved per call); the mark survives
    a restart. Bounded to the newest MAX_AGENT_SESSIONS sessions."""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    @staticmethod
    def _path() -> Path:
        from hermes_constants import get_hermes_home

        return get_hermes_home() / AGENT_ANSWERS_FILE

    def _read(self) -> dict[str, list[str]]:
        try:
            data = json.loads(self._path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        if not isinstance(data, dict):
            return {}
        return {k: [i for i in v if isinstance(i, str)] for k, v in data.items()
                if isinstance(k, str) and isinstance(v, list)}

    def _write(self, data: dict[str, list[str]]) -> None:
        path = self._path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)

    @staticmethod
    def _key(project: str, session_id: str) -> str:
        return json.dumps([project, session_id])

    def ids(self, project: str, session_id: str) -> set[str]:
        with self._lock:
            return set(self._read().get(self._key(project, session_id), []))

    def add(self, project: str, session_id: str, answer_id: str) -> None:
        with self._lock:
            data = self._read()
            key = self._key(project, session_id)
            data[key] = [i for i in data.pop(key, []) if i != answer_id] + [answer_id]  # newest session last
            self._write(dict(list(data.items())[-MAX_AGENT_SESSIONS:]))

    def drop(self, project: str, session_id: str, answer_id: str) -> None:
        with self._lock:
            data = self._read()
            key = self._key(project, session_id)
            if answer_id in data.get(key, []):
                data[key] = [i for i in data[key] if i != answer_id]
                self._write(data)


class MappingService:
    def __init__(self, dg: DgClient, gh: GhBridgeClient, revit: RevitBridgeClient | None = None) -> None:
        if revit is None:
            from .revit_bridge import RevitBridgeClient

            revit = RevitBridgeClient()
        self._dg = dg
        self._gh = gh
        self._revit = revit
        self._agent = AgentAnswers()

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
        return self._marked(panel_session(self._dg.get_mapping_session(_require_id(session_id, "sessionId"), cancel)))

    def answer(self, session_id: Any, question_id: Any, option_id: Any, group_ids: Any = None,
               cancel: CancelToken | None = None, by_agent: bool = False) -> dict[str, Any]:
        """Post one answer; ``by_agent`` (the degram_mapping tool) records it as proposed by the agent (D-121)."""
        session = panel_session(self._dg.post_mapping_decision(
            _require_id(session_id, "sessionId"), _require_id(question_id, "questionId"),
            _require_id(option_id, "optionId"), _group_ids(group_ids), cancel))
        if by_agent and (answer_id := latest_answer_id(session, question_id)):
            self._agent.add(self._dg.bound_project(), session_id, answer_id)
        return self._marked(session)

    def undo(self, session_id: Any, answer_id: Any, cancel: CancelToken | None = None) -> dict[str, Any]:
        session = panel_session(self._dg.undo_mapping_answer(
            _require_id(session_id, "sessionId"), _require_id(answer_id, "answerId"), cancel))
        self._agent.drop(self._dg.bound_project(), session_id, answer_id)
        return self._marked(session)

    def _marked(self, session: dict[str, Any]) -> dict[str, Any]:
        """D-121: ``agentAnswerIds`` = the session's current answers the agent proposed."""
        current = {a.get("answerId") for a in session.get("answers") or [] if isinstance(a, dict)}
        sid = str(session.get("sessionId") or "")
        mine = self._agent.ids(self._dg.bound_project(), sid) if sid else set()
        return {**session, "agentAnswerIds": sorted(i for i in mine if i in current)}

    def apply(self, session_id: Any, request_id: Any, revision: Any, answer_ids: Any,
              cancel: CancelToken | None = None, design_state_name: Any = None,
              design_state_name_source: Any = None) -> dict[str, Any]:
        session_id = _require_id(session_id, "sessionId")
        name = " ".join(str(design_state_name or "").split())
        if len(name) > 120:
            raise ValueError("designStateName must have at most 120 characters")
        if not isinstance(request_id, str) or not 3 <= len(request_id) <= 64:
            raise ValueError("requestId must have 3 to 64 characters")
        if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{24}", revision):
            raise ValueError("revision must be the current 24-character revision")
        if (not isinstance(answer_ids, list) or not answer_ids or len(answer_ids) > 5000
                or not all(isinstance(v, str) and v.strip() and len(v) <= _MAX_ID for v in answer_ids)
                or len(set(answer_ids)) != len(answer_ids)):
            raise ValueError("answerIds must be a nonempty list of unique answer ids")
        source = design_state_name_source if design_state_name_source in ("suggested", "edited") else "edited"
        batch = self._dg.commit_mapping(session_id, request_id, revision, sorted(answer_ids), cancel,
                                        name or None, source)
        # Do not turn a successful commit into a failure if a subsequent session read fails.
        return {k: batch[k] for k in ("batchId", "revision", "answerIds", "committedAt", "delivery") if k in batch}

    def suggest_name(self, session_id: Any, answer_ids: Any, language: Any = "ru",
                     cancel: CancelToken | None = None) -> dict[str, Any]:
        """DG 1303-31 (D-107): the suggested name of the Design State this confirmation records."""
        session_id = _require_id(session_id, "sessionId")
        ids = [v for v in answer_ids or [] if isinstance(v, str) and v.strip()] if isinstance(answer_ids, list) else []
        return self._dg.suggest_design_state_name(session_id, sorted(set(ids)), "en" if language == "en" else "ru",
                                                  cancel)

    # -- CAD side: start and show ---------------------------------------------------------------------
    def start(self, app: Any = "grasshopper", cancel: CancelToken | None = None, filters: Any = None,
              limit: Any = None, after: Any = None) -> dict[str, Any]:
        """Create a session from the CAD model now: CONNECTOR reads the canvas (``start_mapping``), or the DG Revit
        connector reads the active model (``dg_start_mapping``, which also answers the new ``sessionId``): its
        default scope, or the filters that are on with the limit and the continuation (D-123, D-124)."""
        arguments = _start_arguments(filters, limit, after)
        if _app(app, "grasshopper") == "revit":
            reply = self._revit.call("dg_start_mapping", arguments, cancel=cancel)
            session_id = reply.get("sessionId")
            # scope "selection": only the elements selected in Revit were read (D-48); DeGram warns about it (F-10)
            result = {"started": reply.get("started") is True,
                      "sessionId": session_id if isinstance(session_id, str) and session_id else None,
                      "message": str(reply.get("message") or "") or None}
            if reply.get("scope") in _START_SCOPES:
                result["scope"] = reply["scope"]
            for key in _START_COUNTS:
                value = reply.get(key)
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    result[key] = value
            return result
        if arguments:
            raise ValueError("mapping filters apply to a Revit model only")
        reply = self._gh.call("start_mapping", {}, cancel=cancel)
        if not isinstance(reply, dict):
            raise BridgeError(SETUP_INCOMPLETE, "BRIDGE_PROTOCOL", "start_mapping returned no result.")
        return {"started": reply.get("started") is True, "message": str(reply.get("message") or "") or None}

    def filter_lists(self, cancel: CancelToken | None = None) -> dict[str, Any]:
        """D-123: what the Revit filters offer: the model categories that can hold DG_Class (with counts) and the views
        a View filter can name."""
        categories = self._revit.call("dg_list_mapping_categories", {}, cancel=cancel)
        views = self._revit.call("dg_list_mapping_views", {}, cancel=cancel)
        return {"categories": [{k: c.get(k) for k in ("name", "label", "count")}
                               for c in (categories or {}).get("categories") or [] if isinstance(c, dict)],
                "views": [{k: v.get(k) for k in ("id", "name", "type")}
                          for v in (views or {}).get("views") or [] if isinstance(v, dict)]}

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

    # -- Restate (1303-29, D-97) ----------------------------------------------------------------------------
    def restate(self, state_id: Any, cancel: CancelToken | None = None) -> dict[str, Any]:
        """Put a Design State of the Model Viewer back into its model. DG answers what to send (the state's recorded
        placements, or its statePayloadJson); Revit gets them through the DG Revit connector's ``dg_restate`` (one
        transaction, moves and rotations only), Grasshopper through the listener's ``restate_parameters`` (the canvas
        sliders and toggles, all or nothing). Answers ``{connector, stateId, report}``."""
        state_id = _require_id(state_id, "stateId")
        payload = self._dg.get_restate(state_id, cancel)
        if payload["connector"] == "revit":
            placements = payload.get("placements")
            if not isinstance(placements, list) or not placements:
                raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG restate answer has no placements.")
            reply = self._revit.call("dg_restate", {"placements": placements,
                                                    "label": str(payload.get("label") or state_id)}, cancel=cancel)
            report = reply.get("report") if isinstance(reply, dict) else None
            if not isinstance(report, dict):
                raise BridgeError(SETUP_INCOMPLETE, "BRIDGE_PROTOCOL", "dg_restate returned no report.")
            return {"connector": "revit", "stateId": state_id,
                    "report": {k: _count(report.get(k))
                               for k in ("moved", "unchanged", "skipped", "missing", "failed", "recreated")}
                    | {"details": [d for d in report.get("details") or [] if isinstance(d, str)][:20]}}
        reply = self._gh.call("restate_parameters", {"stateId": state_id,
                                                     "statePayloadJson": payload.get("statePayloadJson")},
                              cancel=cancel)
        if not isinstance(reply, dict):
            raise BridgeError(SETUP_INCOMPLETE, "BRIDGE_PROTOCOL", "restate_parameters returned no result.")
        reports = [r for r in reply.get("reports") or [] if isinstance(r, dict)]
        return {"connector": "grasshopper", "stateId": state_id,
                "report": {"applied": reply.get("applied") is True, "aborted": reply.get("aborted") is True,
                           "parameters": len(reports),
                           "details": ["%s: %s" % (r.get("parameterId"), r.get("status")) for r in reports
                                       if r.get("status") not in ("Applied", "Unchanged")][:20]}}

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
