"""Delegated access to the DG backend for the bound project (1301 D-06/D-16, T-1301-11-04; 1303-10).

Reachable, and only for the project of the delegated credential (the project is never a parameter):

- ``GET {relayBaseUrl}/graph/{project}`` and ``GET {relayBaseUrl}/rules/{project}``: the context reads (1301-11);
- ``GET {relayBaseUrl}/mapping/sessions?project=&limit=20`` and ``GET {relayBaseUrl}/mapping/sessions/{id}?project=``:
  the project's mapping sessions;
- ``POST {relayBaseUrl}/mapping/sessions/{id}/decisions`` and ``POST {relayBaseUrl}/mapping/sessions/{id}/undo``:
  answer a mapping proposal, take one answer back (owner decision 2026-10-18, Phase 1303-10: the delegated token
  may read the mapping sessions and post or undo answers of its own project). Creating, applying a session and the
  profile routes stay out of reach.

The token is read from the in-memory credential per request, sent as a Bearer header only (no cookie, so no CSRF
token) and never returned; the server re-checks membership and role. Failures are named: ``DG_UNAVAILABLE``
(unreachable, timeout, 5xx, oversized or malformed answer) and ``ACCESS_DENIED`` (401/403). A mapping request the
server refuses for what it is (400/404/409: unknown session or answer, applied session, invalid option) raises
:class:`DgRefused` with the server's ``detail.code`` and message. No retry, no redirect following."""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import quote, urlencode

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
_SERVER_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_MAX_REFUSAL_MESSAGE = 300


class DgRefused(Exception):
    """The DG backend refused a mapping request for what it is (HTTP 400/404/409). ``code`` is the server's
    ``detail.code`` (``MAPPING_SESSION_APPLIED``, ``MAPPING_ANSWER_NOT_FOUND``, ...), ``message`` its text."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code
        self.message = message


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

    def _scope(self) -> tuple[Any, str]:
        try:
            return self._store.require_info(), self._store.api_key_provider()
        except DegramCredentialsError as exc:
            raise BridgeError(exc.code, None, str(exc).split(": ", 1)[-1]) from exc

    def _send(self, method: str, url: str, token: str, what: str, cancel: CancelToken | None, *,
              body: dict | None = None, refusals: bool = False, read_timeout_s: float | None = None) -> Any:
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
                    if status == 200 or (refusals and status in REFUSAL_STATUSES):
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
        if refusals and status in REFUSAL_STATUSES:
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
                 body: dict | None = None) -> Any:
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
            return self._send("GET", url, token, "mapping", cancel, refusals=True)
        return self._send("POST", f"{info.relay_base_url}{path}", token, "mapping", cancel,
                          body={"project": info.project, **(body or {})}, refusals=True)

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
        """Answer one proposal; the server answers ``{decisions, profiles, session}`` and this returns the session."""
        body: dict[str, Any] = {"questionId": question_id, "optionId": option_id}
        if group_ids is not None:
            body["groupIds"] = list(group_ids)
        data = self._mapping("POST", session_id, "decisions", cancel, body)
        return _session_of(data.get("session") if isinstance(data, dict) else None)

    def undo_mapping_answer(self, session_id: str, answer_id: str, cancel: CancelToken | None = None) -> dict[str, Any]:
        return _session_of(self._mapping("POST", session_id, "undo", cancel, {"answerId": answer_id}))


def _session_of(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict) or not isinstance(data.get("sessionId"), str):
        raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG mapping answer has no session.")
    return data
