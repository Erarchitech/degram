"""Variant degram JSON-RPC handlers: the delegated-credential handoff (plan 10, D-06) and the CAD read
capabilities (plan 11, D-13..D-18).

``degram.credentials.set`` keeps the token in process memory only; ``clear`` wipes it;
``status`` reports presence/scope/expiry and NEVER the token. All three refuse outside variant
degram (a stock Hermes must not grow a credential sink). ``degram.documents.*`` and ``degram.context.*``
list and pin open CAD documents, preview the exact context payload, send a turn with it and cancel an
in-flight read; they refuse outside variant degram too. An operational outcome (BRIDGE_OFF, BUSY,
IDENTITY_MISMATCH, ...) is an ``ok`` RPC result with ``status: "error"`` and a ``code``; a request the gateway
refuses for what it is (unknown or stale preview, bad scope) is a JSON-RPC error with ``data.code``.
The body imports ``degram_variant`` lazily and touches only the server.py globals ``_ok`` / ``_err`` /
``_sessions`` / ``_methods`` (rebound by ``bind_module``).
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
    from degram_variant import runtime
    runtime.reset_scope()  # D-08: the project context, the pinned document and previews go with the credential
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


# -- CAD read capabilities (plan 11) ---------------------------------------------------------------


def _not_degram(rid, method_name: str):
    from degram_variant.lockdown import is_degram
    if not is_degram():
        return _degram_err(rid, 4403, "NOT_DEGRAM", f"{method_name} is only available in variant degram")
    return None


def _outcome(rid, exc):
    return _ok(rid, exc.to_dict())


@method("degram.documents.list")
def _(rid, params: dict) -> dict:
    if (refused := _not_degram(rid, "degram.documents.list")) is not None:
        return refused
    from degram_variant import runtime
    from degram_variant.outcomes import BridgeError
    rt = runtime.get()
    token = rt.cancels.new("documents.list")
    try:
        with token.active():
            return _ok(rid, {"status": "ok", **rt.documents.list(token)})
    except BridgeError as exc:
        return _outcome(rid, exc)
    finally:
        rt.cancels.discard("documents.list", token)


@method("degram.documents.pin")
def _(rid, params: dict) -> dict:
    if (refused := _not_degram(rid, "degram.documents.pin")) is not None:
        return refused
    from degram_variant import runtime
    from degram_variant.outcomes import BridgeError
    rt = runtime.get()
    app = params.get("app")
    if app is None:  # no app: unpin (the card goes back to "no document selected")
        rt.documents.unpin()
        rt.composer.clear()
        return _ok(rid, {"status": "ok", "pinned": None})
    token = rt.cancels.new("documents.pin")
    try:
        with token.active():
            pinned = rt.documents.pin(app, params.get("identity"), token)
    except ValueError as exc:
        return _degram_err(rid, 4400, "BAD_REQUEST", str(exc))
    except BridgeError as exc:
        return _outcome(rid, exc)
    finally:
        rt.cancels.discard("documents.pin", token)
    return _ok(rid, {"status": "ok", "pinned": pinned})


@method("degram.context.preview")
def _(rid, params: dict) -> dict:
    if (refused := _not_degram(rid, "degram.context.preview")) is not None:
        return refused
    from degram_variant import runtime
    from degram_variant.context_composer import ContextError
    try:
        return _ok(rid, runtime.get().composer.preview(params.get("scope") or "selection",
                                                       preview_id=params.get("previewId")))
    except ContextError as exc:
        return _degram_err(rid, exc.rpc_code, exc.code, exc.message)


@method("degram.context.send")
def _(rid, params: dict) -> dict:
    if (refused := _not_degram(rid, "degram.context.send")) is not None:
        return refused
    from degram_variant import relay_headers, runtime
    from degram_variant.context_composer import ContextError
    from degram_variant.outcomes import BridgeError
    sid = params.get("session_id", "")
    session = _sessions.get(sid)
    if session is not None and session.get("running"):
        return _degram_err(rid, 4090, "SESSION_BUSY", "A turn is already running; stop it or wait for it to finish")
    try:
        plan = runtime.get().composer.prepare_send(
            params.get("previewId", ""), params.get("text", ""), consent=params.get("consent") is True,
            scope=params.get("scope"))
    except ContextError as exc:
        return _degram_err(rid, exc.rpc_code, exc.code, exc.message)
    except BridgeError as exc:
        return _outcome(rid, exc)
    submitted = _methods["prompt.submit"](
        rid, {"session_id": sid, "text": plan.message, "_degram_send": relay_headers.SEND_TICKET})
    if "error" in submitted:
        relay_headers.clear()
        return submitted
    return _ok(rid, {"status": "ok", "previewId": plan.preview_id, "scope": plan.scope, "bytes": plan.bytes,
                     "submit": submitted.get("result")})


@method("degram.context.cancel")
def _(rid, params: dict) -> dict:
    if (refused := _not_degram(rid, "degram.context.cancel")) is not None:
        return refused
    from degram_variant import runtime
    return _ok(rid, {"status": "ok", "cancelled": runtime.get().composer.cancel(params.get("previewId"))})


def register(server) -> None:
    bind_module(globals(), server, skip=("_",))
