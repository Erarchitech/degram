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
from collections import OrderedDict
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import dg_client as _dgc
from .cancel import CancelToken
from .dg_client import DgClient, DgRefused, local_refusal, require_pattern
from .gh_bridge import GhBridgeClient
from .outcomes import (
    BUSY,
    CANCELLED,
    DG_UNAVAILABLE,
    DOCUMENT_NOT_OPEN,
    IDENTITY_MISMATCH,
    SETUP_INCOMPLETE,
    BridgeError,
)

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
# DG 1303-35 (advanced Revit mapping). The capability names a connector attests; an advanced or mixed commit needs
# all of them (no partial advanced delivery). Mirrors the framework's closed vocabulary.
ADVANCED_CAPABILITIES = ("instances", "owned-delete", "exact-receipts", "document-validation", "native-intent",
                         "recovery")
# The closed keys of a protected scope (API contract section 9). Anything else, notably a proof-looking flag such as
# ``confirmed``, ``byAgent`` or ``actor``, is refused before any request: a scope names WHAT is confirmed, it can
# never carry that it IS confirmed.
SCOPE_KEYS = frozenset({"definitionId", "definitionVersion", "bindingRevision", "resultHash", "instanceKeys",
                        "generalize", "selectorHash", "matchedCount", "countState", "batchManifestHash"})
MAX_SCOPE_LIST = 500
INTENT_ACTIONS = ("preview-definition", "clear-definition-preview", "advanced-approve", "advanced-bulk-approve", "advanced-skip",
                  "advanced-commit")
MAX_DISPATCHED = 512
MAX_ADVANCED_SESSIONS = 200
_SAFE_INTENT_KEYS = ("intentId", "action", "status", "sessionId", "document", "scopeHash", "expiresAt", "decidedAt",
                     "operation")
MAX_NATIVE_RESULT_CHARS = 65536


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


def clean_scope(scope: Any) -> dict[str, Any]:
    """A protected scope as the closed vocabulary allows it. Unknown keys (every proof-looking flag among them),
    nested objects and oversized lists are refused before any request."""
    if not isinstance(scope, dict) or not scope:
        raise ValueError("scope must be a non-empty object")
    if set(scope) == {"items"}:
        import re
        items = scope["items"]
        keys = {"definitionId", "definitionVersion", "definitionRevision", "modeRevision", "bindingRevision", "resultHash"}
        if not isinstance(items, list) or not 2 <= len(items) <= 100:
            raise ValueError("scope.items must contain 2 to 100 tuples")
        out = []
        for item in items:
            if not isinstance(item, dict) or set(item) != keys:
                raise ValueError("invalid bulk tuple")
            if not isinstance(item["definitionId"], str) or not re.fullmatch(r"MD-[0-9a-f]{12}", item["definitionId"]):
                raise ValueError("invalid definitionId")
            if not isinstance(item["resultHash"], str) or not re.fullmatch(r"[0-9a-f]{16,64}", item["resultHash"]):
                raise ValueError("invalid resultHash")
            for key in ("definitionVersion", "definitionRevision", "modeRevision", "bindingRevision"):
                if type(item[key]) is not int or item[key] < (1 if key in ("definitionVersion", "definitionRevision") else 0):
                    raise ValueError("invalid revision")
            out.append(dict(item))
        ids = [item["definitionId"] for item in out]
        if ids != sorted(set(ids)):
            raise ValueError("bulk definitions must be unique and sorted")
        return {"items": out}
    unknown = sorted(str(k) for k in scope if k not in SCOPE_KEYS)
    if unknown:
        raise ValueError("scope may hold only " + ", ".join(sorted(SCOPE_KEYS)) + "; not " + ", ".join(unknown[:5]))
    clean: dict[str, Any] = {}
    for key, value in scope.items():
        if isinstance(value, list):
            if len(value) > MAX_SCOPE_LIST or not all(isinstance(v, str) and 0 < len(v) <= _MAX_ID for v in value):
                raise ValueError(f"scope.{key} must be a list of at most {MAX_SCOPE_LIST} ids")
        elif not (value is None or isinstance(value, (str, int, bool))) or (isinstance(value, str)
                                                                            and len(value) > _MAX_ID):
            raise ValueError(f"scope.{key} must be a plain value")
        clean[key] = value
    return clean


def _public_intent(value: Any) -> dict[str, Any] | None:
    """The fields of a challenge the surfaces may show (an id, an action, a status): never a proof secret."""
    return {k: value[k] for k in _SAFE_INTENT_KEYS if k in value} if isinstance(value, dict) else None


def _dicts(value: Any) -> list[dict[str, Any]]:
    return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []


def agent_marks(definitions: Any) -> dict[str, list[str]]:
    """Display attribution only, never permission: the classes whose current head version (or pending mode proposal)
    the agent proposed. The server stamps the provenance from the authenticated lane (a delegated token proposes as
    ``agent``); this just reads it."""
    heads: set[str] = set()
    modes: set[str] = set()
    for d in _dicts(definitions):
        class_iri = d.get("classIri")
        if not isinstance(class_iri, str):
            continue
        if isinstance(d.get("head"), dict) and d["head"].get("source") == "agent":
            heads.add(class_iri)
        if isinstance(d.get("modeProposal"), dict) and d["modeProposal"].get("source") == "agent":
            modes.add(class_iri)
    return {"agentDefinitionClasses": sorted(heads), "agentModeProposalClasses": sorted(modes)}


def advanced_state_of(session: dict[str, Any]) -> dict[str, Any]:
    """The advanced section of a Revit session as both surfaces show it: the definitions with their draft head and
    effective approved version side by side (Q5), the model bindings with result hash and the distinct confirmation,
    queued and delivery phases, the pending answers and the offered commit, the model identity and the connector's
    capabilities. A fact the server did not give is None or absent, never invented; ``complete`` is true only for a
    connector that attested every capability."""
    adv = session.get("advanced") if isinstance(session.get("advanced"), dict) else {}
    definitions = _dicts(adv.get("definitions"))
    pending = _dicts(adv.get("pending"))
    valid_pending = {p.get("definitionId") for p in pending if p.get("valid") is True}
    out_definitions = []
    for d in definitions:
        mode = d.get("modeProposal")
        out_definitions.append({**d, "agentProposed": isinstance(d.get("head"), dict) and d["head"].get("source") == "agent",
                                "modeProposedByAgent": isinstance(mode, dict) and mode.get("source") == "agent"})
    bindings = []
    for b in _dicts(adv.get("bindings")):
        confirmation = "skipped" if b.get("skipped") else "approved" if b.get("approved") else "none"
        if b.get("definitionId") in valid_pending:
            confirmation = "pending-answer"  # a draft answer waits for the common commit; the approval stays effective
        materialization = b.get("materialization") if isinstance(b.get("materialization"), dict) else {}
        bindings.append({**b, "confirmation": confirmation, "delivery": materialization.get("state")})
    connector = session.get("connector") if isinstance(session.get("connector"), dict) else {}
    target = connector.get("target") if isinstance(connector.get("target"), dict) else {}
    capabilities = [c for c in target.get("capabilities") or [] if isinstance(c, str)] \
        if isinstance(target.get("capabilities"), list) else []
    missing = [c for c in ADVANCED_CAPABILITIES if c not in capabilities]
    supported = target.get("supported") is True
    batches = _dicts(session.get("batches"))
    last = batches[-1] if batches else None
    delivery = ({"batchId": last.get("batchId"),
                 "state": last["delivery"].get("state") if isinstance(last.get("delivery"), dict) else None}
                if last else None)
    snapshot = last.get("snapshot") if last and isinstance(last.get("snapshot"), dict) else None
    commit = adv.get("commit") if isinstance(adv.get("commit"), dict) else None
    return {"revision": adv.get("revision"), "definitions": out_definitions, "bindings": bindings, "pending": pending,
            "candidates": _dicts(adv.get("candidates")), "commit": commit,
            "affectedModels": _dicts(adv.get("affectedModels")),
            "model": {"document": session.get("document"), "modelKey": target.get("modelKey")},
            "capabilities": capabilities, "missingCapabilities": missing, "supported": supported,
            "complete": bool(target) and supported and not missing,
            "delivery": delivery, "snapshot": snapshot, **agent_marks(definitions)}


class _Fence:
    """Captures the credential generation (and, for model-bound calls, the pinned-model generation) when a call
    starts; ``check`` raises once either moved, so a reply that arrives after the scope went A -> B -> A, the
    credential was revoked or the model was re-pinned is dropped instead of being shown for the wrong target."""

    def __init__(self, dg: DgClient, documents: Any | None = None) -> None:
        self._dg, self._documents = dg, documents
        self._credentials = dg.generation()
        self._pins = documents.generation if documents is not None else None

    def check(self, native: bool = False) -> None:
        if self._dg.generation() != self._credentials or (self._documents is not None
                                                          and self._documents.generation != self._pins):
            extra = {"unresolved": True} if native else {}
            raise BridgeError(CANCELLED, "SCOPE_CHANGED",
                              "The DG scope or the pinned model changed while the call ran; its reply was discarded."
                              + (" The native step may have run: read the session again." if native else ""), **extra)


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
    def __init__(self, dg: DgClient, gh: GhBridgeClient, revit: RevitBridgeClient | None = None,
                 documents: Any | None = None) -> None:
        if revit is None:
            from .revit_bridge import RevitBridgeClient

            revit = RevitBridgeClient()
        self._dg = dg
        self._gh = gh
        self._revit = revit
        self._documents = documents  # the pinned documents (DocumentsService); None: no model-bound advanced reads
        self._agent = AgentAnswers()
        # 1303-35: a native action of one challenge runs at most once per door in this process; the pending
        # protected answers a panel read showed, so an apply that names one without the commit proof is refused.
        self._dispatched: OrderedDict[tuple[str, str, str], bool] = OrderedDict()
        self._dispatch_lock = threading.Lock()
        self._advanced_pending: OrderedDict[tuple[str, str], frozenset[str]] = OrderedDict()

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
        fence = self._fence(models=True)
        session = self._dg.get_mapping_session(_require_id(session_id, "sessionId"), cancel)
        fence.check()
        return self._marked(panel_session(session))

    def answer(self, session_id: Any, question_id: Any, option_id: Any, group_ids: Any = None,
               cancel: CancelToken | None = None, by_agent: bool = False) -> dict[str, Any]:
        """Post one answer; ``by_agent`` (the degram_mapping tool) records it as proposed by the agent (D-121)."""
        fence = self._fence(models=True)
        session = panel_session(self._dg.post_mapping_decision(
            _require_id(session_id, "sessionId"), _require_id(question_id, "questionId"),
            _require_id(option_id, "optionId"), _group_ids(group_ids), cancel))
        fence.check()
        if by_agent and (answer_id := latest_answer_id(session, question_id)):
            self._agent.add(self._dg.bound_project(), session_id, answer_id)
        return self._marked(session)

    def undo(self, session_id: Any, answer_id: Any, cancel: CancelToken | None = None) -> dict[str, Any]:
        """Ordinary/agent Undo cannot revoke a protected advanced draft. Inspect canonical state, not id prefixes
        or a caller-supplied flag. The existing UI RPC uses its separate, non-agent entry below."""
        session_id = _require_id(session_id, "sessionId")
        answer_id = _require_id(answer_id, "answerId")
        fence = self._fence(models=True)
        current = self._dg.get_mapping_session(session_id, cancel)
        fence.check()
        answers = [a for a in _dicts(current.get("answers")) if a.get("answerId") == answer_id]
        pending = _dicts((current.get("advanced") or {}).get("pending"))
        if (_dgc.is_protected_question(answer_id)
                or any(a.get("type") == "advanced-answer" or "advancedAnswer" in a
                       or _dgc.is_protected_question(a.get("questionId")) for a in answers)
                or any(a.get("answerId") == answer_id for a in pending)):
            raise local_refusal(409, "MAPPING_PROTECTED_ANSWER",
                                "An advanced draft can only be taken back from the user's mapping card.")
        if not answers:
            raise local_refusal(404, "MAPPING_ANSWER_NOT_FOUND", "The ordinary answer is not in the current session.")
        return self._undo_answer(session_id, answer_id, cancel, fence)

    def undo_from_ui(self, session_id: Any, answer_id: Any, cancel: CancelToken | None = None) -> dict[str, Any]:
        """Existing user-card Undo (draft only, enforced by DG). Not exposed as an agent action or proof flag.
        Undo does not approve, commit, delete native instances or issue a human intent."""
        return self._undo_answer(_require_id(session_id, "sessionId"), _require_id(answer_id, "answerId"), cancel,
                                 self._fence(models=True))

    def _undo_answer(self, session_id: str, answer_id: str, cancel: CancelToken | None, fence: _Fence) -> dict[str, Any]:
        session = panel_session(self._dg.undo_mapping_answer(session_id, answer_id, cancel))
        fence.check()
        self._agent.drop(self._dg.bound_project(), session_id, answer_id)
        return self._marked(session)

    def _marked(self, session: dict[str, Any]) -> dict[str, Any]:
        """D-121: ``agentAnswerIds`` = the session's current answers the agent proposed. 1303-35: a Revit session
        with an advanced section also carries ``advancedState`` (the one reading both surfaces use)."""
        current = {a.get("answerId") for a in session.get("answers") or [] if isinstance(a, dict)}
        sid = str(session.get("sessionId") or "")
        mine = self._agent.ids(self._dg.bound_project(), sid) if sid else set()
        out = {**session, "agentAnswerIds": sorted(i for i in mine if i in current)}
        if isinstance(session.get("advanced"), dict):
            out["advancedState"] = advanced_state_of(session)
            self._remember_pending(sid, session)
        return out

    def _remember_pending(self, session_id: str, session: dict[str, Any]) -> None:
        ids = frozenset(p["answerId"] for p in _dicts((session.get("advanced") or {}).get("pending"))
                        if isinstance(p.get("answerId"), str))
        key = (self._dg.bound_project(), session_id)
        with self._dispatch_lock:
            self._advanced_pending.pop(key, None)
            self._advanced_pending[key] = ids
            while len(self._advanced_pending) > MAX_ADVANCED_SESSIONS:
                self._advanced_pending.popitem(last=False)

    def _known_advanced_answers(self, session_id: str) -> frozenset[str]:
        with self._dispatch_lock:
            return self._advanced_pending.get((self._dg.bound_project(), session_id), frozenset())

    def apply(self, session_id: Any, request_id: Any, revision: Any, answer_ids: Any,
              cancel: CancelToken | None = None, design_state_name: Any = None,
              design_state_name_source: Any = None, intent_id: Any = None) -> dict[str, Any]:
        """The common confirmation. ``intent_id`` (1303-35) is the reference of the member's native-confirmed
        ``advanced-commit`` proof; advanced or mixed work needs it, and only the proof the server offered for exactly
        this commit is sent. This method never posts a receipt or a connector protocol (those are connector-only)."""
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
        fence = None
        if intent_id is None:
            if self._known_advanced_answers(session_id) & set(answer_ids):
                raise local_refusal(409, "INTENT_REQUIRED",
                                    "This commit names an advanced answer: it needs a member's native confirmation "
                                    "of the exact commit (advanced-commit).")
        else:
            require_pattern(intent_id, _dgc._INTENT_ID, "intentId")
            fence = self._fence(models=True)
            self._verify_commit_proof(session_id, intent_id, cancel, fence)
        batch = self._dg.commit_mapping(session_id, request_id, revision, sorted(answer_ids), cancel,
                                        name or None, source, intent_id)
        if fence is not None:
            fence.check()  # the scope moved while DG confirmed: the reply is not shown for the wrong target
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

    # -- advanced Revit mapping (DG 1303-35; the routes and the native tools are plan 1303-34's) -----------------
    # The agent reads the pinned model, proposes definitions and modes and derives through one canonical server
    # request. It cannot approve, skip, preview, clear, apply or confirm: those take the reference of a member's
    # native-confirmed intent (checked here against the server, then enforced by it), and the three native doors
    # (confirm, preview, clear) are the main-process broker's, reached only through ``RevitBridgeClient.call_native``.
    def _check_project(self, project: Any) -> None:
        if project is not None and project != self._dg.bound_project():
            raise ValueError("project is not the bound project of this DeGram session")

    def _fence(self, models: bool = False) -> _Fence:
        return _Fence(self._dg, self._documents if models else None)

    def _pin(self) -> dict[str, Any]:
        pin = self._documents.pinned.get("revit") if self._documents is not None else None
        if not pin:
            raise BridgeError(DOCUMENT_NOT_OPEN, "NO_PINNED_MODEL", "Pin the Revit model first; nothing was read.")
        return pin

    @staticmethod
    def _check_model(pin: dict[str, Any], model: Any) -> None:
        """An explicit ``model`` argument must be the pinned model; it never selects another one."""
        if model is None:
            return
        if not isinstance(model, dict):
            raise ValueError("model must be a document identity {creationGuid, pathName}")
        identity = pin.get("identity") or {}
        if (not model.get("creationGuid") or model.get("creationGuid") != identity.get("creationGuid")
                or (model.get("pathName") or "") != (identity.get("pathName") or "")):
            raise BridgeError(IDENTITY_MISMATCH, "MODEL_NOT_PINNED",
                              "The model named is not the pinned Revit model; nothing was read.")

    def _require_open(self, pin: dict[str, Any], cancel: CancelToken | None, active: bool) -> None:
        """The pinned model must be open in Revit (and, for a read of the live selection or overview, the active one)."""
        reply = self._revit.call("list_open_documents", {}, cancel=cancel)
        identity = pin.get("identity") or {}
        rows = [d for d in reply.get("documents") or [] if isinstance(d, dict)] if isinstance(reply, dict) else []
        row = next((d for d in rows if d.get("creationGuid") == identity.get("creationGuid")
                    and (d.get("pathName") or "") == (identity.get("pathName") or "")), None)
        if row is None:
            raise BridgeError(DOCUMENT_NOT_OPEN, "PINNED_MODEL_NOT_OPEN", "The pinned Revit model is not open.")
        if active and row.get("isActive") is not True:
            raise BridgeError(IDENTITY_MISMATCH, "PINNED_MODEL_NOT_ACTIVE",
                              "The pinned Revit model is not the active one; nothing was read.")

    def _pinned_read(self, tool: str, project: Any, model: Any, cancel: CancelToken | None) -> dict[str, Any]:
        self._check_project(project)
        pin = self._pin()
        self._check_model(pin, model)
        fence = self._fence(models=True)
        self._require_open(pin, cancel, active=True)
        fence.check()
        reply = self._revit.call(tool, {}, cancel=cancel)
        fence.check()
        self._require_open(pin, cancel, active=True)  # still the active one after the read, or the reply is dropped
        fence.check()
        return {**(reply if isinstance(reply, dict) else {}), "model": {"name": pin.get("name"),
                                                                       "unsaved": pin.get("unsaved") is True}}

    def overview(self, project: Any = None, model: Any = None, cancel: CancelToken | None = None) -> dict[str, Any]:
        """The read-only overview of the PINNED Revit model (base point, grids, levels, categories). Another project
        or model argument is refused before any tool call; the pinned model must be the active one."""
        return self._pinned_read("dg_model_overview", project, model, cancel)

    def selection(self, project: Any = None, model: Any = None, cancel: CancelToken | None = None) -> dict[str, Any]:
        """The current selection of the PINNED Revit model (UniqueIds, at most 500)."""
        return self._pinned_read("dg_read_selection", project, model, cancel)

    def definitions(self, cancel: CancelToken | None = None) -> dict[str, Any]:
        fence = self._fence(models=True)
        data = self._dg.get_definitions(cancel)
        fence.check()
        return {**data, **agent_marks(data["definitions"])}

    def propose(self, class_iri: Any, kind: Any, recipe: Any, text: Any = None, answer_summary: Any = None,
                expected_revision: Any = None, cancel: CancelToken | None = None) -> dict[str, Any]:
        """Save a DRAFT definition (compare-and-set). The approved version stays effective until a member confirms a
        replacement; the server records this lane as ``agent``. No Revit call: deriving is a separate step."""
        fence = self._fence(models=True)
        definition = self._dg.propose_definition(class_iri, kind, recipe, text, answer_summary, expected_revision,
                                                 cancel)
        fence.check()
        return {"definition": definition, **agent_marks([definition])}

    def propose_mode(self, definition_id: Any, mode: Any, expected_revision: Any, reason: Any = None,
                     cancel: CancelToken | None = None) -> dict[str, Any]:
        """Propose the class mode (compare-and-set). It is a proposal: the effective mode and any approved instance
        stay until a member confirms at the common commit."""
        fence = self._fence(models=True)
        proposal = self._dg.propose_mode(definition_id, mode, expected_revision, reason, cancel)
        fence.check()
        return proposal

    def derive(self, session_id: Any, definition_id: Any, request_id: Any, definition_version: Any = None,
               binding: Any = None, expected_binding_revision: Any = None, status_only: Any = False,
               project: Any = None, model: Any = None, cancel: CancelToken | None = None) -> dict[str, Any]:
        """One canonical derive: DG freezes the request (definition version, recipe, model binding), the connector
        fetches it by id, derives read-only and posts the result itself, and this reads the outcome back. The
        outcome is explicit (ok, failed, needs-input, pending, unresolved); a timeout is never answered by asking
        the connector again, only by the status link. ``status_only`` reads the status and asks nothing."""
        session_id = _require_id(session_id, "sessionId")
        require_pattern(session_id, _dgc._SESSION_ID, "sessionId")
        require_pattern(definition_id, _dgc._DEFINITION_ID, "definitionId")
        require_pattern(request_id, _dgc._REQUEST_ID, "requestId")
        _dgc._revision(definition_version, 1, "definitionVersion", optional=True)
        _dgc._revision(expected_binding_revision, 0, "expectedBindingRevision", optional=True)
        if binding is not None and not isinstance(binding, dict):
            raise ValueError("binding must be an object")
        self._check_project(project)
        if status_only is True:
            return self._derive_outcome(session_id, definition_id, request_id, None, {}, False, self._fence(), cancel)
        pin = self._pin()
        self._check_model(pin, model)
        fence = self._fence(models=True)
        session = self._dg.get_mapping_session(session_id, cancel)
        fence.check()
        if session.get("platform") != "revit" or session_document(session) != document_key(pin.get("name")):
            raise BridgeError(IDENTITY_MISMATCH, "SESSION_NOT_OF_PINNED_MODEL",
                              "The mapping session belongs to another model than the pinned one; nothing was derived.")
        self._require_open(pin, cancel, active=False)
        fence.check()
        frozen = self._dg.request_derive(session_id, definition_id, request_id, definition_version, binding,
                                         expected_binding_revision, cancel)
        fence.check()
        native: dict[str, Any] = {}
        unresolved = False
        try:
            reply = self._revit.call("dg_derive_definition", {"request_id": request_id}, cancel=cancel)
            native = reply if isinstance(reply, dict) else {}
        except BridgeError as exc:
            if exc.code != BUSY:
                raise
            unresolved = True  # the connector may still be deriving: read the status, never ask twice
        fence.check()
        return self._derive_outcome(session_id, definition_id, request_id, frozen, native, unresolved, fence, cancel)

    def _derive_outcome(self, session_id: str, definition_id: str, request_id: str, frozen: dict[str, Any] | None,
                        native: dict[str, Any], unresolved: bool, fence: _Fence,
                        cancel: CancelToken | None) -> dict[str, Any]:
        status = self._dg.derive_status(session_id, request_id, cancel)
        fence.check()
        request = status.get("request") if isinstance(status.get("request"), dict) else {}
        out: dict[str, Any] = {
            "requestId": request_id, "requestHash": (frozen or {}).get("requestHash") or status.get("requestHash"),
            "bindingRevision": status.get("bindingRevision"),
            "definitionId": status.get("definitionId") or request.get("definitionId") or definition_id}
        if status["status"] == "completed":
            result_status = status.get("resultStatus")
            outcome = result_status if result_status in ("ok", "failed", "needs-input") else "unknown"
            out.update(outcome=outcome, ok=outcome == "ok", resultStatus=result_status,
                       resultHash=status.get("resultHash"), change=status.get("change"))
        else:
            out.update(outcome="unresolved" if unresolved else "pending", ok=False)
            out["statusLink"] = {"route": "advanced-derive-status", "sessionId": session_id, "requestId": request_id}
        if native.get("derived") is False:
            code, message = native.get("code"), native.get("message")
            if isinstance(code, str):
                out["nativeCode"] = code[:64]
            if isinstance(message, str):
                out["nativeMessage"] = message[:300]
        return out

    def advanced_state(self, session_id: Any, cancel: CancelToken | None = None) -> dict[str, Any]:
        """The advanced section of one Revit session as both surfaces show it (definitions, bindings, pending answers,
        the offered commit, the model, the connector's capabilities)."""
        session_id = _require_id(session_id, "sessionId")
        fence = self._fence(models=True)
        session = self._dg.get_mapping_session(session_id, cancel)
        fence.check()
        self._remember_pending(session_id, session)
        return {"sessionId": session_id, **advanced_state_of(session)}

    # -- protected actions: a proof by reference, checked against the server before anything is sent -------------
    def _check_intent(self, intent: dict[str, Any], session_id: str, intent_id: str, action: str | None,
                      scope: dict[str, Any] | None, want: str, spent_code: str = "INTENT_NOT_CONFIRMED",
                      replay_request: str | None = None) -> None:
        """The challenge must be exactly this one (id, project, session, action, scope) and in the wanted state. The
        server re-checks everything when it consumes or claims it; this only keeps a wrong or spent reference from
        costing a request or a dialog."""
        if (intent.get("intentId") != intent_id or intent.get("project") != self._dg.bound_project()
                or intent.get("sessionId") != session_id or intent.get("action") not in INTENT_ACTIONS
                or (action is not None and intent.get("action") != action)
                or (scope is not None and intent.get("scope") != scope)):
            raise local_refusal(409, "INTENT_HASH_CONFLICT",
                                "The challenge is not the one for this action, session and scope.")
        status = intent.get("status")
        if want == "pending":
            if status != "pending":
                raise local_refusal(409, "INTENT_NOT_PENDING", f"The challenge is {status}, not waiting for an answer.")
            return
        if status == "consumed" and replay_request is not None and intent.get("consumedFor") == replay_request:
            # Only the plural server operation provides durable manifest/actor/request replay.
            # This permits its exact retry, not another native dispatch or a new approval.
            return
        if status in ("claimed", "consumed"):
            raise local_refusal(409, spent_code, f"The challenge is already {status}.")
        if status != "confirmed":
            raise local_refusal(409, "INTENT_NOT_CONFIRMED", f"The challenge is {status}, not confirmed by a person.")

    def answer_advanced(self, session_id: Any, request_id: Any, intent_id: Any, action: Any, scope: Any,
                        cancel: CancelToken | None = None) -> dict[str, Any]:
        """Approve or skip one advanced class as a DRAFT answer, under the reference of a member's native-confirmed
        intent for exactly this action and scope. No proof flag is ever accepted from the caller."""
        session_id = _require_id(session_id, "sessionId")
        require_pattern(session_id, _dgc._SESSION_ID, "sessionId")
        require_pattern(request_id, _dgc._REQUEST_ID, "requestId")
        require_pattern(intent_id, _dgc._INTENT_ID, "intentId")
        if action not in _dgc.ADVANCED_ACTIONS:
            raise ValueError(f"action must be one of {', '.join(_dgc.ADVANCED_ACTIONS)}")
        scope = clean_scope(scope)
        fence = self._fence(models=True)
        intent = self._dg.get_human_intent(session_id, intent_id, cancel)
        fence.check()
        self._check_intent(intent, session_id, intent_id, f"advanced-{action}", scope, "confirmed")
        session = self._dg.post_advanced_answer(session_id, request_id, intent_id, action, scope, cancel)
        fence.check()
        return self._marked(panel_session(session))

    def answers_advanced(self, session_id: Any, request_id: Any, intent_id: Any, scope: Any,
                         cancel: CancelToken | None = None) -> dict[str, Any]:
        session_id = _require_id(session_id, "sessionId")
        require_pattern(session_id, _dgc._SESSION_ID, "sessionId")
        require_pattern(request_id, _dgc._REQUEST_ID, "requestId")
        require_pattern(intent_id, _dgc._INTENT_ID, "intentId")
        scope = clean_scope(scope)
        if set(scope) != {"items"}:
            raise ValueError("bulk scope required")
        fence = self._fence(models=True)
        intent = self._dg.get_human_intent(session_id, intent_id, cancel)
        fence.check()
        self._check_intent(intent, session_id, intent_id, "advanced-bulk-approve", scope, "confirmed",
                           replay_request=request_id)
        session = self._dg.post_advanced_answers(session_id, request_id, intent_id, scope, cancel)
        fence.check()
        return self._marked(panel_session(session))

    def _verify_commit_proof(self, session_id: str, intent_id: str, cancel: CancelToken | None, fence: _Fence) -> None:
        """Before an advanced or mixed commit is sent: the connector attested every capability (an old one is refused
        whole, the drafts are kept) and the proof is the confirmed ``advanced-commit`` for the commit DG offers."""
        session = self._dg.get_mapping_session(session_id, cancel)
        fence.check()
        state = advanced_state_of(session)
        if not state["complete"]:
            raise local_refusal(409, "ADVANCED_DELIVERY_UNAVAILABLE",
                                "The DG connector of this session cannot deliver advanced mapping. Update and "
                                "reconnect it, or undo the advanced answers; the drafts are kept.")
        manifest = (state["commit"] or {}).get("batchManifestHash")
        if not isinstance(manifest, str) or not manifest:
            raise local_refusal(409, "INTENT_HASH_CONFLICT", "The session offers no advanced commit to confirm.")
        intent = self._dg.get_human_intent(session_id, intent_id, cancel)
        fence.check()
        self._check_intent(intent, session_id, intent_id, "advanced-commit", {"batchManifestHash": manifest},
                           "confirmed")

    # -- the broker's native doors: once per challenge, outcome never guessed -----------------------------------
    def _claim_dispatch(self, door: str, intent_id: str) -> None:
        key = (self._dg.bound_project(), door, intent_id)
        with self._dispatch_lock:
            if key in self._dispatched:
                raise local_refusal(409, "INTENT_ALREADY_DISPATCHED",
                                    "This challenge was already sent to Revit; read its status, do not repeat it.")
            self._dispatched[key] = True
            while len(self._dispatched) > MAX_DISPATCHED:
                self._dispatched.popitem(last=False)

    def _release_dispatch(self, door: str, intent_id: str) -> None:
        with self._dispatch_lock:
            self._dispatched.pop((self._dg.bound_project(), door, intent_id), None)

    def _native(self, door: str, tool: str, session_id: str, intent_id: str, fence: _Fence,
                cancel: CancelToken | None) -> dict[str, Any]:
        try:
            reply = self._revit.call_native(tool, {"intent_id": intent_id}, cancel=cancel)
        except BridgeError as exc:
            if exc.extra.get("unresolved"):
                extra = dict(exc.extra)
                extra["statusLink"] = {"route": "human-intent", "sessionId": session_id, "intentId": intent_id}
                try:  # best effort: the server's own account of the challenge, without the (cancelled) call token
                    extra["intent"] = _public_intent(self._dg.get_human_intent(session_id, intent_id))
                except (BridgeError, DgRefused, ValueError):
                    pass
                raise BridgeError(exc.code, exc.reason, exc.message, **extra) from exc
            if exc.code == SETUP_INCOMPLETE and exc.reason == "REVIT_ADAPTER_NOT_CONNECTED":
                self._release_dispatch(door, intent_id)  # nothing reached Revit: the person may try again
            raise
        fence.check(native=True)
        return reply if isinstance(reply, dict) else {}

    def confirm_intent(self, session_id: Any, intent_id: Any, scope: Any,
                       cancel: CancelToken | None = None) -> dict[str, Any]:
        """Open the native confirmation dialog for a pending challenge the main process issued for this member.
        Only a person pressing Yes there confirms (the connector posts the receipt); this posts nothing, and only the
        exact decision ``confirmed`` is reported as confirmed. The scope echo must be the challenge's own."""
        session_id = _require_id(session_id, "sessionId")
        require_pattern(session_id, _dgc._SESSION_ID, "sessionId")
        require_pattern(intent_id, _dgc._INTENT_ID, "intentId")
        scope = clean_scope(scope)
        fence = self._fence(models=True)
        intent = self._dg.get_human_intent(session_id, intent_id, cancel)
        fence.check()
        self._check_intent(intent, session_id, intent_id, None, scope, "pending")
        self._claim_dispatch("confirm", intent_id)
        reply = self._native("confirm", "dg_confirm_mapping_intent", session_id, intent_id, fence, cancel)
        decision = "confirmed" if reply.get("decision") == "confirmed" else "cancelled"
        return {"outcome": decision, "decision": decision, "intent": _public_intent(reply.get("intent"))}

    def preview(self, session_id: Any, intent_id: Any, cancel: CancelToken | None = None) -> dict[str, Any]:
        """Preview a definition natively for a confirmed ``preview-definition`` challenge (the result stored in DG, the
        authorization the person gave; never geometry from the renderer)."""
        return self._protected_native("preview", "preview-definition", "dg_preview_definition", session_id, intent_id,
                                      cancel)

    def clear_preview(self, session_id: Any, intent_id: Any, cancel: CancelToken | None = None) -> dict[str, Any]:
        """Remove the owned preview for a confirmed ``clear-definition-preview`` challenge (that definition's own
        preview only, never a generic delete)."""
        return self._protected_native("clear", "clear-definition-preview", "dg_clear_definition_preview", session_id,
                                      intent_id, cancel)

    def _protected_native(self, door: str, action: str, tool: str, session_id: Any, intent_id: Any,
                          cancel: CancelToken | None) -> dict[str, Any]:
        session_id = _require_id(session_id, "sessionId")
        require_pattern(session_id, _dgc._SESSION_ID, "sessionId")
        require_pattern(intent_id, _dgc._INTENT_ID, "intentId")
        fence = self._fence(models=True)
        intent = self._dg.get_human_intent(session_id, intent_id, cancel)
        fence.check()
        self._check_intent(intent, session_id, intent_id, action, None, "confirmed", "INTENT_ALREADY_CLAIMED")
        self._claim_dispatch(door, intent_id)
        reply = self._native(door, tool, session_id, intent_id, fence, cancel)
        outcome = reply.get("outcome") if isinstance(reply.get("outcome"), str) else "unknown"
        operation = reply.get("operationId") if isinstance(reply.get("operationId"), str) else None
        current = intent
        try:  # the challenge as DG now sees it (claimed or consumed after the native step)
            current = self._dg.get_human_intent(session_id, intent_id)
        except (BridgeError, DgRefused, ValueError):
            pass
        result = reply.get("result")
        if result is not None and len(json.dumps(result, default=str)) > MAX_NATIVE_RESULT_CHARS:
            result = None
        return {"outcome": outcome, "operationId": operation, "intent": _public_intent(current), "result": result}

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
