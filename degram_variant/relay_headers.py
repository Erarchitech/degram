"""Per-request provenance headers of the DG relay (1301 D-17, plan 08 contract; plan 11 owns sending them).

The relay reads ``X-DeGram-Context-Scope`` (``none | selection | whole-definition``, default ``selection`` when absent)
and, for whole-definition scope, ``X-DeGram-Whole-Definition-Consent: true``. The OpenAI SDK fixes its default headers
when the client is built, so the headers travel as per-request ``extra_headers`` through the one seam every
chat-completion request passes (``agent.fast_mode.effective_request_overrides``).

The context is set by ``ContextComposer.prepare_send`` right before the turn is submitted and holds until the next
prompt is submitted any other way (``on_prompt_submit``): a later plain message never inherits a whole-definition
consent. A client cannot forge the "this submit comes from send" ticket: it is an in-process object, not JSON."""

from __future__ import annotations

import threading
from typing import Any

SCOPE_HEADER = "X-DeGram-Context-Scope"
CONSENT_HEADER = "X-DeGram-Whole-Definition-Consent"
SCOPES = ("none", "selection", "whole-definition")

SEND_TICKET = object()  # passed by degram.context.send to prompt.submit; JSON params cannot carry it

_lock = threading.Lock()
_context: tuple[str, bool] | None = None


def set_turn_context(scope: str, consent: bool = False) -> None:
    if scope not in SCOPES:
        raise ValueError(f"unknown context scope {scope!r}")
    with _lock:
        global _context
        _context = (scope, bool(consent) and scope == "whole-definition")


def clear() -> None:
    with _lock:
        global _context
        _context = None


def current() -> tuple[str, bool] | None:
    with _lock:
        return _context


def request_headers() -> dict[str, str]:
    """The provenance headers for a request made now. Without a context the scope is ``none`` (never an implicit
    ``selection``: a request that was not composed by the context card carries no CAD data)."""
    ctx = current()
    scope, consent = ctx if ctx else ("none", False)
    headers = {SCOPE_HEADER: scope}
    if consent:
        headers[CONSENT_HEADER] = "true"
    return headers


def augment_request_overrides(overrides: dict[str, Any]) -> dict[str, Any]:
    """Hook in ``effective_request_overrides``: a copy of ``overrides`` with the provenance ``extra_headers`` in
    variant degram, the input untouched elsewhere."""
    from .lockdown import is_degram

    if not is_degram():
        return overrides
    merged = {**(overrides.get("extra_headers") or {}), **request_headers()}
    return {**overrides, "extra_headers": merged}


def on_prompt_submit(params: dict[str, Any]) -> None:
    """Hook at the top of ``prompt.submit``: anything but ``degram.context.send`` resets the context to ``none``."""
    from .lockdown import is_degram

    if is_degram() and params.get("_degram_send") is not SEND_TICKET:
        clear()
