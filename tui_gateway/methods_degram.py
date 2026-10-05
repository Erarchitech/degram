"""Variant degram JSON-RPC handlers: the delegated-credential handoff (plan 10, D-06).

``degram.credentials.set`` keeps the token in process memory only; ``clear`` wipes it;
``status`` reports presence/scope/expiry and NEVER the token. All three refuse outside variant
degram (a stock Hermes must not grow a credential sink). The body imports ``degram_variant``
lazily and touches no server.py global except ``_ok`` / ``_err`` (rebound by ``bind_module``).
"""

import logging
import time

from .method_ctx import HandlerRegistry, bind_module

logger = logging.getLogger(__name__)
_registry = HandlerRegistry()
method = _registry.method


def _degram_err(rid, code: int, name: str, message: str):
    return _err(rid, code, f"{name}: {message}", {"code": name})


@method("degram.credentials.set")
def _(rid, params: dict) -> dict:
    from degram_variant.credentials import DegramCredentialsError, credentials
    from degram_variant.lockdown import is_degram
    if not is_degram():
        return _degram_err(rid, 4403, "NOT_DEGRAM", "degram.credentials.set is only available in variant degram")
    try:
        info = credentials.set(
            token=params.get("token"), expires_at=params.get("expiresAt"),
            relay_base_url=params.get("relayBaseUrl"), user=params.get("user"),
            company=params.get("company"), project=params.get("project"))
    except DegramCredentialsError as exc:
        return _degram_err(rid, 4400, exc.code, str(exc).split(": ", 1)[-1])
    return _ok(rid, {"ok": True, "expiresAt": info.expires_at})


@method("degram.credentials.clear")
def _(rid, params: dict) -> dict:
    from degram_variant.credentials import credentials
    from degram_variant.lockdown import is_degram
    if not is_degram():
        return _degram_err(rid, 4403, "NOT_DEGRAM", "degram.credentials.clear is only available in variant degram")
    credentials.clear()
    return _ok(rid, {"ok": True})


@method("degram.credentials.status")
def _(rid, params: dict) -> dict:
    from degram_variant.credentials import credentials
    info = credentials.info()
    if info is None:
        return _ok(rid, {"present": False, "expired": False})
    return _ok(rid, {
        "present": True, "expired": time.time() >= info.expires_at, "expiresAt": info.expires_at,
        "relayBaseUrl": info.relay_base_url, "user": info.user, "company": info.company,
        "project": info.project})


def register(server) -> None:
    bind_module(globals(), server, skip=("_",))
