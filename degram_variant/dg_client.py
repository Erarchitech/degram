"""Delegated access to the DG backend for the bound project (1301 D-06/D-16, T-1301-11-04; 1303-10).

Reachable, and only for the project of the delegated credential (the project is never a parameter):

- ``GET {relayBaseUrl}/graph/{project}`` and ``GET {relayBaseUrl}/rules/{project}``: the context reads (1301-11);
- ``GET {relayBaseUrl}/mapping/sessions?project=&limit=20`` and ``GET {relayBaseUrl}/mapping/sessions/{id}?project=``:
  the project's mapping sessions;
- ``POST {relayBaseUrl}/mapping/sessions/{id}/decisions`` and ``POST {relayBaseUrl}/mapping/sessions/{id}/undo``:
  answer a mapping proposal, take one answer back (owner decision 2026-10-18, Phase 1303-10: the delegated token
  may read the mapping sessions and post or undo answers of its own project). Creating sessions and the profile
  routes stay out of reach.
- ``POST {relayBaseUrl}/mapping/sessions/{id}/apply`` carries explicit batch intent from the shared button. This
  server requires the bound project and a live editor role. Delivery receipts remain connector-only; any
  ACCESS_DENIED is returned without credential fallback.

- 1303-35 (advanced Revit mapping): ``GET {relayBaseUrl}/mapping/definitions``, ``POST .../definitions`` and
  ``.../definitions/mode`` (compare-and-set proposals), ``POST .../sessions/{id}/advanced/derive`` and
  ``GET .../advanced/derive/{requestId}`` (one canonical read-only request and its outcome),
  ``GET .../sessions/{id}/human-intents/{intentId}`` (the status of a challenge) and
  ``POST .../sessions/{id}/advanced/answer`` (a protected answer under the reference of a member's native-confirmed
  intent). The delegated token proposes as ``agent`` (the server stamps it from the lane) and cannot issue,
  confirm, claim or consume an intent, post a derive result or a delivery receipt: there is no method here for any
  of them.

The token is read from the in-memory credential per request, sent as a Bearer header only (no cookie, so no CSRF
token) and never returned; the server re-checks membership and role. Failures are named: ``DG_UNAVAILABLE``
(unreachable, timeout, 5xx, oversized or malformed answer) and ``ACCESS_DENIED`` (401/403). A mapping request the
server refuses for what it is (400/404/409: unknown session or answer, applied session, invalid option) raises
:class:`DgRefused` with the server's ``detail.code`` and message. No retry, no redirect following."""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Any
from urllib.parse import quote, unquote, urlencode

import httpx

from .cancel import CancelToken, check
from .credentials import DegramCredentials, DegramCredentialsError, credentials as _credentials
from .outcomes import ACCESS_DENIED, DG_UNAVAILABLE, BridgeError

MAX_RESPONSE_BYTES = 8 * 1024 * 1024
CONNECT_TIMEOUT_S = 5.0
TIMEOUT = httpx.Timeout(connect=CONNECT_TIMEOUT_S, read=20.0, write=5.0, pool=5.0)
READ_ROUTES = ("graph", "rules")  # GET {relay}/{route}/{project}
MAPPING_SESSIONS_LIMIT = 20
REFUSAL_STATUSES = frozenset({400, 404, 409})
ADVANCED_REFUSAL_STATUSES = REFUSAL_STATUSES | {422}
_SERVER_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_MAX_REFUSAL_MESSAGE = 300
_PROTECTED_QUESTION = re.compile(r"^advanced\s*:")
_DEFINITION_ID = re.compile(r"^MD-[0-9a-f]{12}$")
_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:-]{3,64}$")
_INTENT_ID = re.compile(r"^[A-Za-z0-9._:-]{3,128}$")
_SESSION_ID = re.compile(r"^[A-Za-z0-9._:-]{3,128}$")
DEFINITION_KINDS = ("derived", "compound", "direct")
DEFINITION_MODES = ("ordinary", "advanced")
ADVANCED_ACTIONS = ("approve", "skip")
MAX_DEFINITION_TEXT = 2000


def is_protected_question(value: Any) -> bool:
    """True for a question id that names a protected advanced action, however it is spelled. The server refuses the
    exact prefix ``advanced:`` (409 ``MAPPING_PROTECTED_QUESTION``); this is stricter and runs first, so the ordinary
    answer never even tries a case, width, zero-width, control or percent-encoded variant."""
    if not isinstance(value, str):
        return False
    text = value
    for _ in range(3):  # a doubly encoded colon is still a colon
        text = unicodedata.normalize("NFKC", unquote(text))
    text = "".join(ch for ch in text if unicodedata.category(ch) not in ("Cf", "Cc", "Cs", "Co", "Cn"))
    return bool(_PROTECTED_QUESTION.match(text.strip().casefold()))


class DgRefused(Exception):
    """The DG backend refused a mapping request for what it is (HTTP 400/404/409). ``code`` is the server's
    ``detail.code`` (``MAPPING_SESSION_APPLIED``, ``MAPPING_ANSWER_NOT_FOUND``, ...), ``message`` its text."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code
        self.message = message


def local_refusal(status: int, code: str, message: str) -> DgRefused:
    """A refusal this component makes BEFORE any request (same shape as the server's, so callers map one type)."""
    return DgRefused(status, code, message[:_MAX_REFUSAL_MESSAGE])


def require_pattern(value: Any, pattern: re.Pattern, field: str) -> str:
    if not isinstance(value, str) or not pattern.match(value):
        raise ValueError(f"{field} is not a valid id")
    return value


def _refusal(status: int, body: bytes) -> DgRefused:
    detail: Any = None
    try:
        data = json.loads(body.decode("utf-8")) if body else None
        detail = data.get("detail") if isinstance(data, dict) else None
    except ValueError:
        pass
    code = str(detail.get("code") or "") if isinstance(detail, dict) else ""
    text = ""
    if isinstance(detail, dict):
        text = str(detail.get("error") or detail.get("message") or detail.get("hint") or "")
    elif isinstance(detail, str):
        text = detail
    if not _SERVER_CODE.match(code):
        code = f"HTTP_{status}"
    return DgRefused(status, code, (text or f"The DG backend refused the request (HTTP {status}).")[:_MAX_REFUSAL_MESSAGE])


class DgClient:
    def __init__(self, store: DegramCredentials | None = None) -> None:
        self._store = store or _credentials

    def generation(self) -> int:
        """Counts every credential ``set`` and ``clear`` of this process (0 for a store that has none). A caller
        captures it before a remote step and drops the reply when it moved: the scope may have gone A -> B -> A."""
        return int(getattr(self._store, "generation", 0) or 0)

    def bound_project(self) -> str:
        """The project of the delegated credential (never a parameter)."""
        return str(self._scope()[0].project)

    def _scope(self) -> tuple[Any, str]:
        try:
            return self._store.require_info(), self._store.api_key_provider()
        except DegramCredentialsError as exc:
            raise BridgeError(exc.code, None, str(exc).split(": ", 1)[-1]) from exc

    def _send(self, method: str, url: str, token: str, what: str, cancel: CancelToken | None, *,
              body: dict | None = None, refusals: bool = False, read_timeout_s: float | None = None,
              refusal_statuses: frozenset[int] = REFUSAL_STATUSES) -> Any:
        check(cancel)
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        content = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            content = json.dumps(body).encode("utf-8")
        timeout = TIMEOUT if read_timeout_s is None else httpx.Timeout(
            connect=CONNECT_TIMEOUT_S, read=read_timeout_s, write=5.0, pool=5.0)
        try:
            with httpx.Client(timeout=timeout, follow_redirects=False) as client:
                with client.stream(method, url, headers=headers, content=content) as response:
                    status = response.status_code
                    data = bytearray()
                    if status == 200 or (refusals and status in refusal_statuses):
                        for chunk in response.iter_bytes():
                            check(cancel)
                            data += chunk
                            if len(data) > MAX_RESPONSE_BYTES:
                                raise BridgeError(DG_UNAVAILABLE, "RESPONSE_TOO_LARGE",
                                                  f"The DG {what} answer exceeded {MAX_RESPONSE_BYTES} bytes.")
        except BridgeError:
            raise
        except httpx.HTTPError as exc:
            raise BridgeError(DG_UNAVAILABLE, "UNREACHABLE", f"The DG backend could not be reached ({type(exc).__name__}).") from exc
        if status in (401, 403):
            raise BridgeError(ACCESS_DENIED, f"HTTP_{status}", "The DG backend refused the delegated token for this project.")
        if refusals and status in refusal_statuses:
            raise _refusal(status, bytes(data))
        if status != 200:
            raise BridgeError(DG_UNAVAILABLE, f"HTTP_{status}", f"The DG backend answered HTTP {status}.")
        try:
            return json.loads(bytes(data).decode("utf-8"))
        except ValueError as exc:
            raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG backend answered with malformed JSON.") from exc

    def _get(self, route: str, cancel: CancelToken | None, query: str = "", read_timeout_s: float | None = None) -> Any:
        if route not in READ_ROUTES:
            raise BridgeError(DG_UNAVAILABLE, "ROUTE_NOT_ALLOWED", f"DG route {route!r} is not readable by DeGram.")
        check(cancel)
        info, token = self._scope()
        url = f"{info.relay_base_url}/{route}/{quote(info.project, safe='')}{query}"
        return self._send("GET", url, token, route, cancel, read_timeout_s=read_timeout_s)

    def get_rules(self, cancel: CancelToken | None = None, read_timeout_s: float | None = None) -> list[dict[str, Any]]:
        data = self._get("rules", cancel, read_timeout_s=read_timeout_s)
        rules = data.get("rules") if isinstance(data, dict) else None
        if not isinstance(rules, list):
            raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG rules answer has no rules list.")
        return [{"ruleId": str(r.get("ruleId", "")), "text": str(r.get("text", ""))} for r in rules if isinstance(r, dict)]

    def get_graph(self, cancel: CancelToken | None = None) -> dict[str, Any]:
        # Gap G-1: the compact read caps each property value server-side and sorts validation records last, so a
        # project with validation history fits MAX_RESPONSE_BYTES and keeps its ontology and rules in the node cap.
        data = self._get("graph", cancel, "?compact=true")
        if not isinstance(data, dict) or not isinstance(data.get("nodes"), list):
            raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG graph answer has no node list.")
        return {"nodes": data["nodes"], "rels": data.get("rels") if isinstance(data.get("rels"), list) else []}

    # -- mapping sessions of the bound project (1303-10) -------------------------------------------------
    def _mapping(self, method: str, session_id: str | None, action: str | None, cancel: CancelToken | None,
                 body: dict | None = None, refusal_statuses: frozenset[int] = REFUSAL_STATUSES) -> Any:
        check(cancel)
        info, token = self._scope()
        path = "/mapping/sessions"
        if session_id is not None:
            path += f"/{quote(session_id, safe='')}"
        if action is not None:
            path += f"/{action}"
        if method == "GET":
            query = {"project": info.project}
            if session_id is None:
                query["limit"] = str(MAPPING_SESSIONS_LIMIT)
            url = f"{info.relay_base_url}{path}?{urlencode(query)}"
            return self._send("GET", url, token, "mapping", cancel, refusals=True, refusal_statuses=refusal_statuses)
        return self._send("POST", f"{info.relay_base_url}{path}", token, "mapping", cancel,
                          body={"project": info.project, **(body or {})}, refusals=True,
                          refusal_statuses=refusal_statuses)

    def list_mapping_sessions(self, cancel: CancelToken | None = None) -> list[dict[str, Any]]:
        data = self._mapping("GET", None, None, cancel)
        sessions = data.get("sessions") if isinstance(data, dict) else None
        if not isinstance(sessions, list):
            raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG mapping answer has no session list.")
        return [s for s in sessions if isinstance(s, dict)]

    def get_mapping_session(self, session_id: str, cancel: CancelToken | None = None) -> dict[str, Any]:
        return _session_of(self._mapping("GET", session_id, None, cancel))

    def post_mapping_decision(self, session_id: str, question_id: str, option_id: str,
                              group_ids: list[str] | None = None, cancel: CancelToken | None = None) -> dict[str, Any]:
        """Answer one proposal; the server answers ``{decisions, profiles, session}`` and this returns the session.
        A protected ``advanced:`` question is never an ordinary answer, in any spelling (1303-35)."""
        if is_protected_question(question_id):
            raise local_refusal(409, "MAPPING_PROTECTED_QUESTION",
                                "This question is a protected action and cannot be answered as an ordinary mapping "
                                "answer. It needs a member's native confirmation.")
        body: dict[str, Any] = {"questionId": question_id, "optionId": option_id}
        if group_ids is not None:
            body["groupIds"] = list(group_ids)
        data = self._mapping("POST", session_id, "decisions", cancel, body)
        return _session_of(data.get("session") if isinstance(data, dict) else None)

    def undo_mapping_answer(self, session_id: str, answer_id: str, cancel: CancelToken | None = None) -> dict[str, Any]:
        return _session_of(self._mapping("POST", session_id, "undo", cancel, {"answerId": answer_id}))

    # -- Restate of a Design State (1303-29, D-97) ----------------------------------------------------------
    def get_restate(self, state_id: str, cancel: CancelToken | None = None) -> dict[str, Any]:
        """What DeGram sends to put a Design State back into its model: ``{connector: "revit", stateId, label,
        placements}`` or ``{connector: "grasshopper", stateId, statePayloadJson}``. A state recorded before
        Restate existed is refused (422 ``RESTATE_NOT_AVAILABLE``)."""
        check(cancel)
        info, token = self._scope()
        url = (f"{info.relay_base_url}/validation/restate/{quote(info.project, safe='')}/"
               f"{quote(state_id, safe='')}")
        data = self._send("GET", url, token, "restate", cancel, refusals=True,
                          refusal_statuses=REFUSAL_STATUSES | {422})
        if not isinstance(data, dict) or data.get("connector") not in ("revit", "grasshopper"):
            raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG restate answer names no connector.")
        return data

    # -- property check of the bound project (1303-15) ------------------------------------------------------
    def property_check(self, action: str, cancel: CancelToken | None = None, *, check_id: str | None = None,
                       name: str | None = None, name_source: str | None = None) -> dict[str, Any]:
        """``generate``: DG writes the property scripts for the current rules and places the check on the canvas;
        ``run``: re-places it when the rules' properties changed, then checks the current Design State and paints
        Revit; ``clear``: removes the colours; ``status``: reads the last result; ``name`` (DG 1303-31, D-106): the
        confirmed name of the new Design State of a pending check, which DG then publishes. Always the bound
        project."""
        routes = {
            "generate": ("/scripts/property-calculator/place", {}),
            "run": ("/scripts/property-check/run", {}),
            "clear": ("/scripts/property-check/run", {"clear": True}),
            "status": ("/scripts/property-check/status", {}),
        }
        if action == "name":
            if not check_id or not (name or "").strip():
                raise BridgeError(DG_UNAVAILABLE, "BAD_ACTION", "action 'name' needs checkId and designStateName.")
            routes["name"] = (f"/scripts/property-check/{quote(check_id, safe='')}/name",
                              {"designStateName": " ".join(name.split()),
                               "designStateNameSource": "suggested" if name_source == "suggested" else "edited"})
        if action not in routes:
            raise BridgeError(DG_UNAVAILABLE, "BAD_ACTION", f"Unknown property-check action {action!r}.")
        check(cancel)
        info, token = self._scope()
        path, extra = routes[action]
        return self._send("POST", f"{info.relay_base_url}{path}", token, "property check", cancel,
                          body={"project": info.project, **extra}, refusals=True, read_timeout_s=150.0,
                          refusal_statuses=REFUSAL_STATUSES | {422, 502, 503})

    def commit_mapping(self, session_id: str, request_id: str, revision: str, answer_ids: list[str],
                       cancel: CancelToken | None = None, design_state_name: str | None = None,
                       design_state_name_source: str | None = None, intent_id: str | None = None) -> dict[str, Any]:
        """Explicit intent only; DG still enforces the principal's existing apply permission. A Revit confirmation
        records a Design State and carries its confirmed name (DG 1303-31, D-106). ``intent_id`` (1303-35) is the
        reference of the member's native-confirmed ``advanced-commit`` proof; it is the only advanced field this
        sends: the receipt and the connector protocol are connector-only and never travel from here."""
        body: dict[str, Any] = {"requestId": request_id, "revision": revision, "answerIds": list(answer_ids)}
        if design_state_name:
            body.update(designStateName=design_state_name, designStateNameSource=design_state_name_source or "edited")
        if intent_id is not None:
            body["intentId"] = require_pattern(intent_id, _INTENT_ID, "intentId")
        states = ("queued", "written", "failed") + (("unknown", "undone") if intent_id is not None else ())
        data = self._mapping("POST", session_id, "apply", cancel, body,
                             refusal_statuses=ADVANCED_REFUSAL_STATUSES if intent_id is not None else REFUSAL_STATUSES)
        if (not isinstance(data, dict) or data.get("batchId") != request_id
                or data.get("revision") != revision or data.get("answerIds") != answer_ids
                or not isinstance(data.get("delivery"), dict)
                or data["delivery"].get("state") not in states):
            raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG mapping answer has no confirmed batch.")
        return data

    # -- advanced Revit mapping (1303-35; routes of plan 1303-34, API contract sections 9-11) ---------------------
    def _advanced(self, method: str, path: str, cancel: CancelToken | None, body: dict | None = None,
                  read_timeout_s: float | None = None) -> Any:
        """One call of a definition, derive, intent or advanced-answer route for the bound project. The project is
        the credential's (never a parameter); 422 is a named refusal here (portability, measurement, scope)."""
        check(cancel)
        info, token = self._scope()
        base = f"{info.relay_base_url}{path}"
        if method == "GET":
            return self._send("GET", f"{base}?{urlencode({'project': info.project})}", token, "mapping", cancel,
                              refusals=True, refusal_statuses=ADVANCED_REFUSAL_STATUSES,
                              read_timeout_s=read_timeout_s)
        return self._send("POST", base, token, "mapping", cancel, body={"project": info.project, **(body or {})},
                          refusals=True, refusal_statuses=ADVANCED_REFUSAL_STATUSES, read_timeout_s=read_timeout_s)

    def get_definitions(self, cancel: CancelToken | None = None) -> dict[str, Any]:
        """The shared definitions of the project and a sanitized view of the model bindings (no native ids)."""
        data = self._advanced("GET", "/mapping/definitions", cancel)
        if not isinstance(data, dict) or not isinstance(data.get("definitions"), list):
            raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG definitions answer has no definition list.")
        bindings = data.get("bindings")
        return {"definitions": [d for d in data["definitions"] if isinstance(d, dict)],
                "bindings": [b for b in bindings if isinstance(b, dict)] if isinstance(bindings, list) else []}

    def propose_definition(self, class_iri: str, kind: str, recipe: dict, text: str | None = None,
                           answer_summary: dict | None = None, expected_revision: int | None = None,
                           cancel: CancelToken | None = None) -> dict[str, Any]:
        """Propose a new DRAFT version of a class definition (compare-and-set on ``expected_revision``); the
        effective approved version is untouched. The server stamps the proposer ``agent`` for this lane."""
        if not isinstance(class_iri, str) or not class_iri.strip() or len(class_iri) > 300:
            raise ValueError("classIri is required")
        if kind not in DEFINITION_KINDS:
            raise ValueError(f"kind must be one of {', '.join(DEFINITION_KINDS)}")
        if not isinstance(recipe, dict) or not recipe:
            raise ValueError("recipe must be a non-empty object")
        if text is not None and (not isinstance(text, str) or len(text) > MAX_DEFINITION_TEXT):
            raise ValueError(f"text must have at most {MAX_DEFINITION_TEXT} characters")
        if answer_summary is not None and not isinstance(answer_summary, dict):
            raise ValueError("answerSummary must be an object")
        _revision(expected_revision, 1, "expectedRevision", optional=True)
        body: dict[str, Any] = {"classIri": class_iri.strip(), "kind": kind, "recipe": recipe}
        if text is not None:
            body["text"] = text
        if answer_summary is not None:
            body["answerSummary"] = answer_summary
        if expected_revision is not None:
            body["expectedRevision"] = expected_revision
        return _definition_of(self._advanced("POST", "/mapping/definitions", cancel, body))

    def propose_mode(self, definition_id: str, mode: str, expected_revision: int, reason: str | None = None,
                     cancel: CancelToken | None = None) -> dict[str, Any]:
        """Propose the class mode (compare-and-set); a proposal only, applied at the common confirmation."""
        require_pattern(definition_id, _DEFINITION_ID, "definitionId")
        if mode not in DEFINITION_MODES:
            raise ValueError(f"mode must be one of {', '.join(DEFINITION_MODES)}")
        _revision(expected_revision, 1, "expectedRevision")
        if reason is not None and (not isinstance(reason, str) or len(reason) > 500):
            raise ValueError("reason must have at most 500 characters")
        body: dict[str, Any] = {"definitionId": definition_id, "mode": mode, "expectedRevision": expected_revision}
        if reason is not None:
            body["reason"] = reason
        return _definition_of(self._advanced("POST", "/mapping/definitions/mode", cancel, body))

    def request_derive(self, session_id: str, definition_id: str, request_id: str,
                       definition_version: int | None = None, binding: dict | None = None,
                       expected_binding_revision: int | None = None,
                       cancel: CancelToken | None = None) -> dict[str, Any]:
        """Freeze one canonical read-only derive request for the session's model. The connector fetches exactly
        this by id and posts the result; nothing here posts, or could post, a result."""
        require_pattern(session_id, _SESSION_ID, "sessionId")
        require_pattern(definition_id, _DEFINITION_ID, "definitionId")
        require_pattern(request_id, _REQUEST_ID, "requestId")
        _revision(definition_version, 1, "definitionVersion", optional=True)
        _revision(expected_binding_revision, 0, "expectedBindingRevision", optional=True)
        if binding is not None and not isinstance(binding, dict):
            raise ValueError("binding must be an object")
        body: dict[str, Any] = {"definitionId": definition_id, "requestId": request_id}
        if definition_version is not None:
            body["definitionVersion"] = definition_version
        if binding is not None:
            body["binding"] = binding
        if expected_binding_revision is not None:
            body["expectedBindingRevision"] = expected_binding_revision
        data = self._advanced("POST", f"/mapping/sessions/{quote(session_id, safe='')}/advanced/derive", cancel, body)
        if (not isinstance(data, dict) or data.get("requestId") != request_id
                or not isinstance(data.get("requestHash"), str)):
            raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG derive answer has no frozen request.")
        return data

    def derive_status(self, session_id: str, request_id: str, cancel: CancelToken | None = None) -> dict[str, Any]:
        """The frozen request (``pending``) or its outcome (``completed``): the status link of a derive."""
        require_pattern(session_id, _SESSION_ID, "sessionId")
        require_pattern(request_id, _REQUEST_ID, "requestId")
        data = self._advanced(
            "GET", f"/mapping/sessions/{quote(session_id, safe='')}/advanced/derive/{quote(request_id, safe='')}",
            cancel)
        if not isinstance(data, dict) or data.get("status") not in ("pending", "completed"):
            raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG derive status has no state.")
        return data

    def get_human_intent(self, session_id: str, intent_id: str, cancel: CancelToken | None = None) -> dict[str, Any]:
        """The canonical manifest and status of one challenge (no credential, no proof secret). Read only: this
        client cannot issue, confirm, claim or consume one."""
        require_pattern(session_id, _SESSION_ID, "sessionId")
        require_pattern(intent_id, _INTENT_ID, "intentId")
        data = self._advanced(
            "GET", f"/mapping/sessions/{quote(session_id, safe='')}/human-intents/{quote(intent_id, safe='')}", cancel)
        if not isinstance(data, dict) or not isinstance(data.get("status"), str) or not isinstance(data.get("scope"), dict):
            raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG intent answer has no status.")
        return data

    def post_advanced_answer(self, session_id: str, request_id: str, intent_id: str, action: str, scope: dict,
                             cancel: CancelToken | None = None) -> dict[str, Any]:
        """Approve or skip one advanced class as a DRAFT answer under a member's native-confirmed intent. The server
        checks the proof for exactly this action and scope and spends it once for this ``request_id``."""
        require_pattern(session_id, _SESSION_ID, "sessionId")
        require_pattern(request_id, _REQUEST_ID, "requestId")
        require_pattern(intent_id, _INTENT_ID, "intentId")
        if action not in ADVANCED_ACTIONS:
            raise ValueError(f"action must be one of {', '.join(ADVANCED_ACTIONS)}")
        if not isinstance(scope, dict):
            raise ValueError("scope must be an object")
        data = self._advanced("POST", f"/mapping/sessions/{quote(session_id, safe='')}/advanced/answer", cancel,
                              {"requestId": request_id, "intentId": intent_id, "action": action, "scope": scope})
        return _session_of(data)

    def post_advanced_answers(self, session_id: str, request_id: str, intent_id: str, scope: dict,
                              cancel: CancelToken | None = None) -> dict[str, Any]:
        require_pattern(session_id, _SESSION_ID, "sessionId")
        require_pattern(request_id, _REQUEST_ID, "requestId")
        require_pattern(intent_id, _INTENT_ID, "intentId")
        if not isinstance(scope, dict):
            raise ValueError("scope must be an object")
        data = self._advanced("POST", f"/mapping/sessions/{quote(session_id, safe='')}/advanced/answers", cancel,
                              {"requestId": request_id, "intentId": intent_id, "scope": scope})
        return _session_of(data)

    def suggest_design_state_name(self, session_id: str, answer_ids: list[str], language: str,
                                  cancel: CancelToken | None = None) -> dict[str, Any]:
        """DG 1303-31 (D-107): DG's suggested name for the Design State a mapping confirmation records
        ({name, source: llm | fallback}); records nothing."""
        check(cancel)
        info, token = self._scope()
        data = self._send("POST", f"{info.relay_base_url}/designstate/{quote(info.project, safe='')}/name-suggestion",
                          token, "mapping", cancel, refusals=True, read_timeout_s=60.0,
                          body={"kind": "mapping", "mappingSessionId": session_id, "answerIds": list(answer_ids),
                                "language": language})
        if not isinstance(data, dict) or not isinstance(data.get("name"), str):
            raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG answer has no suggested name.")
        return {"name": data["name"], "source": data.get("source") or "llm"}


def _revision(value: Any, minimum: int, field: str, optional: bool = False) -> None:
    if value is None and optional:
        return
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"{field} must be a whole number of at least {minimum}")


def _definition_of(data: Any) -> dict[str, Any]:
    definition = data.get("definition") if isinstance(data, dict) else None
    if not isinstance(definition, dict) or not isinstance(definition.get("definitionId"), str):
        raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG definition answer has no definition.")
    return definition


def _session_of(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict) or not isinstance(data.get("sessionId"), str):
        raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG mapping answer has no session.")
    return data
