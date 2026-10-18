"""Variant degram JSON-RPC handlers: the delegated-credential handoff (plan 10, D-06), the CAD read
capabilities (plan 11, D-13..D-18) and the Mapping sub-tab of «Модели» (``degram.mapping.*``, Phase 1303-10).

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
            return _ok(rid, {"status": "ok", **rt.documents.list(token, params.get("app"))})
    except ValueError as exc:
        return _degram_err(rid, 4400, "BAD_REQUEST", str(exc))
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
    if app is None:  # legacy "app: null" unpins every bridge; the renderer calls degram.documents.unpin
        rt.documents.unpin_all()
        rt.composer.clear()
        return _ok(rid, {"status": "ok", "pinned": rt.documents.pinned})
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


@method("degram.documents.unpin")
def _(rid, params: dict) -> dict:
    """D-29: forget one bridge's pinned document (``app``) or every pin (``app`` null); the other bridge keeps its own."""
    if (refused := _not_degram(rid, "degram.documents.unpin")) is not None:
        return refused
    from degram_variant import runtime
    rt = runtime.get()
    app = params.get("app")
    try:
        if app is None:
            rt.documents.unpin_all()
        else:
            rt.documents.unpin(app)
    except ValueError as exc:
        return _degram_err(rid, 4400, "BAD_REQUEST", str(exc))
    rt.composer.clear()
    return _ok(rid, {"status": "ok", "pinned": rt.documents.pinned})


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


# -- Mapping sub-tab of «Модели» (Phase 1303-10) -----------------------------------------------------
# DG sessions with the delegated token of the bound project and the Grasshopper canvas commands. A bridge or DG
# failure is an outcome result like degram.documents.*; a request DG refuses for what it is (unknown session or
# answer, applied session, invalid option: HTTP 400/404/409) is a JSON-RPC error whose data.code is DG's own code.

_REFUSAL_RPC_CODES = {400: 4400, 404: 4404, 409: 4409}


def _mapping_call(rid, name: str, call) -> dict:
    if (refused := _not_degram(rid, name)) is not None:
        return refused
    from degram_variant import runtime
    from degram_variant.dg_client import DgRefused
    from degram_variant.outcomes import BridgeError
    rt = runtime.get()
    token = rt.cancels.new(name)
    try:
        with token.active():
            return _ok(rid, {"status": "ok", **call(rt.mapping, token)})
    except ValueError as exc:
        return _degram_err(rid, 4400, "BAD_REQUEST", str(exc))
    except DgRefused as exc:
        return _err(rid, _REFUSAL_RPC_CODES.get(exc.status, 4400), f"{exc.code}: {exc.message}",
                    {"code": exc.code, "status": exc.status})
    except BridgeError as exc:
        return _outcome(rid, exc)
    finally:
        rt.cancels.discard(name, token)


@method("degram.mapping.sessions")
def _(rid, params: dict) -> dict:
    return _mapping_call(rid, "degram.mapping.sessions",
                         lambda m, t: m.sessions(params.get("document"), params.get("app"), t))


@method("degram.mapping.session")
def _(rid, params: dict) -> dict:
    return _mapping_call(rid, "degram.mapping.session",
                         lambda m, t: {"session": m.session(params.get("sessionId"), t)})


@method("degram.mapping.answer")
def _(rid, params: dict) -> dict:
    return _mapping_call(rid, "degram.mapping.answer", lambda m, t: {"session": m.answer(
        params.get("sessionId"), params.get("questionId"), params.get("optionId"), params.get("groupIds"), t)})


@method("degram.mapping.undo")
def _(rid, params: dict) -> dict:
    return _mapping_call(rid, "degram.mapping.undo",
                         lambda m, t: {"session": m.undo(params.get("sessionId"), params.get("answerId"), t)})


@method("degram.mapping.start")
def _(rid, params: dict) -> dict:
    return _mapping_call(rid, "degram.mapping.start", lambda m, t: m.start(t))


@method("degram.mapping.focus")
def _(rid, params: dict) -> dict:
    return _mapping_call(rid, "degram.mapping.focus", lambda m, t: m.focus(params.get("componentId"), t))


def register(server) -> None:
    bind_module(globals(), server, skip=("_",))
