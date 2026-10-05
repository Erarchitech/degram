"""Delegated, read-only access to the DG backend for the bound project (1301 D-06/D-16, T-1301-11-04).

Only ``GET {relayBaseUrl}/graph/{project}`` and ``GET {relayBaseUrl}/rules/{project}`` are reachable, and only for the
project of the delegated credential. The token is read from the in-memory credential per request and is never
returned; the server re-checks membership (plan 05). Failures are named: ``DG_UNAVAILABLE`` (unreachable, timeout,
5xx, oversized or malformed answer) and ``ACCESS_DENIED`` (401/403). No retry, no redirect following."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from .cancel import CancelToken, check
from .credentials import DegramCredentials, DegramCredentialsError, credentials as _credentials
from .outcomes import ACCESS_DENIED, DG_UNAVAILABLE, BridgeError

MAX_RESPONSE_BYTES = 8 * 1024 * 1024
TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=5.0, pool=5.0)
READ_ROUTES = ("graph", "rules")  # the whole surface of this client


class DgClient:
    def __init__(self, store: DegramCredentials | None = None) -> None:
        self._store = store or _credentials

    def _get(self, route: str, cancel: CancelToken | None) -> Any:
        if route not in READ_ROUTES:
            raise BridgeError(DG_UNAVAILABLE, "ROUTE_NOT_ALLOWED", f"DG route {route!r} is not readable by DeGram.")
        check(cancel)
        try:
            info = self._store.require_info()
            token = self._store.api_key_provider()
        except DegramCredentialsError as exc:
            raise BridgeError(exc.code, None, str(exc).split(": ", 1)[-1]) from exc
        url = f"{info.relay_base_url}/{route}/{quote(info.project, safe='')}"
        try:
            with httpx.Client(timeout=TIMEOUT, follow_redirects=False) as client:
                with client.stream("GET", url, headers={"Authorization": f"Bearer {token}",
                                                         "Accept": "application/json"}) as response:
                    status = response.status_code
                    body = bytearray()
                    if status == 200:
                        for chunk in response.iter_bytes():
                            check(cancel)
                            body += chunk
                            if len(body) > MAX_RESPONSE_BYTES:
                                raise BridgeError(DG_UNAVAILABLE, "RESPONSE_TOO_LARGE",
                                                  f"The DG {route} answer exceeded {MAX_RESPONSE_BYTES} bytes.")
        except BridgeError:
            raise
        except httpx.HTTPError as exc:
            raise BridgeError(DG_UNAVAILABLE, "UNREACHABLE", f"The DG backend could not be reached ({type(exc).__name__}).") from exc
        if status in (401, 403):
            raise BridgeError(ACCESS_DENIED, f"HTTP_{status}", "The DG backend refused the delegated token for this project.")
        if status != 200:
            raise BridgeError(DG_UNAVAILABLE, f"HTTP_{status}", f"The DG backend answered HTTP {status}.")
        try:
            import json
            return json.loads(bytes(body).decode("utf-8"))
        except ValueError as exc:
            raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG backend answered with malformed JSON.") from exc

    def get_rules(self, cancel: CancelToken | None = None) -> list[dict[str, Any]]:
        data = self._get("rules", cancel)
        rules = data.get("rules") if isinstance(data, dict) else None
        if not isinstance(rules, list):
            raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG rules answer has no rules list.")
        return [{"ruleId": str(r.get("ruleId", "")), "text": str(r.get("text", ""))} for r in rules if isinstance(r, dict)]

    def get_graph(self, cancel: CancelToken | None = None) -> dict[str, Any]:
        data = self._get("graph", cancel)
        if not isinstance(data, dict) or not isinstance(data.get("nodes"), list):
            raise BridgeError(DG_UNAVAILABLE, "MALFORMED", "The DG graph answer has no node list.")
        return {"nodes": data["nodes"], "rels": data.get("rels") if isinstance(data.get("rels"), list) else []}
