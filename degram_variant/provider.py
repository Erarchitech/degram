"""The one model route of variant degram: the DG user-scoped relay (1301 D-16, plan 08 contract).

Provider ``custom`` pointed at ``<relayBaseUrl>/degram/v1`` (``POST /chat/completions``, SSE), Bearer
token from the in-memory delegated credential. The relay overrides the model, so the agent sends a
constant alias; there is no fallback chain and no credential pool.
"""

from __future__ import annotations

from typing import Any

from .credentials import DegramCredentials, credentials as _credentials

DEGRAM_MODEL_ALIAS = "degram-system"
DEGRAM_PROVIDER = "custom"
DEGRAM_API_MODE = "chat_completions"
RELAY_API_PREFIX = "/degram/v1"


def relay_v1_url(relay_base_url: str) -> str:
    return f"{relay_base_url.rstrip('/')}{RELAY_API_PREFIX}"


def pinned_runtime(store: DegramCredentials | None = None) -> dict[str, Any]:
    """The runtime dict the gateway hands to ``AIAgent``. Raises ``DegramCredentialsError``
    (CREDENTIALS_MISSING) when no scope credential was set yet: an agent is never built without a relay."""
    store = store or _credentials
    info = store.require_info()
    return {
        "provider": DEGRAM_PROVIDER,
        "requested_provider": DEGRAM_PROVIDER,
        "base_url": relay_v1_url(info.relay_base_url),
        "api_key": store.api_key_provider,  # callable: the SDK reads the current token per request
        "api_mode": DEGRAM_API_MODE,
        "credential_pool": None,
        "command": None,
        "args": None,
        "request_overrides": None,
        "source": "degram-relay",
    }


def pinned_model_and_runtime(store: DegramCredentials | None = None) -> tuple[str, dict[str, Any]]:
    return DEGRAM_MODEL_ALIAS, pinned_runtime(store)


# The named outcomes the DG relay reports in an HTTP error body ({"detail": {"code", "error", "hint", ...}},
# data-service/degram_relay.py). Every one is terminal in the agent: no retry, no fallback (1300 D-10, D-18).
RELAY_ERROR_CODES = frozenset({
    "POLICY_DENY", "CONSENT_REQUIRED", "RELAY_NOT_CONFIGURED", "PROVIDER_TIMEOUT", "PROVIDER_RATE_LIMITED",
    "PROVIDER_UNAVAILABLE", "PROVIDER_ERROR", "CONTEXT_SCOPE_INVALID", "RELAY_BODY_TOO_LARGE"})
_RELAY_EXTRA_FIELDS = ("reason", "retryAfter", "upstreamStatus")

# A relay 401/403 that names no code of its own is still the relay refusing the delegated credential or the project
# access, never a provider key problem: it maps to a named DeGram outcome so the stock auth/api_key surface (which
# names the provider and offers key actions) is never reached (1301-19, G-4, DGCL-02).
STATUS_OUTCOME_CODES = {401: "CREDENTIALS_INVALID", 403: "ACCESS_DENIED"}
_STATUS_OUTCOME_MESSAGES = {
    401: "the DG relay did not accept the delegated credential.",
    403: "the DG relay denied access to this project.",
}


def _error_bodies(error: BaseException):
    """Candidate JSON bodies of an SDK status error and its cause chain."""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        body = getattr(current, "body", None)
        if not isinstance(body, dict):
            response = getattr(current, "response", None)
            try:
                body = response.json() if response is not None else None
            except Exception:  # noqa: BLE001 - a non-JSON body is simply not a relay outcome
                body = None
        if isinstance(body, dict):
            yield body
        current = current.__cause__ or current.__context__


def _error_status(error: BaseException) -> int | None:
    """The HTTP status of an SDK status error or of anything in its cause chain."""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        for holder in (current, getattr(current, "response", None)):
            status = getattr(holder, "status_code", None)
            if isinstance(status, int) and not isinstance(status, bool):
                return status
        current = current.__cause__ or current.__context__
    return None


def relay_outcome(error: BaseException) -> dict[str, Any] | None:
    """The relay's named operational outcome behind an API error (``{"code", "message", "hint", "reason"?, ...}``), or
    None when the error is not one of the relay's own answers. In variant degram a 401/403 that names no code maps to
    CREDENTIALS_INVALID / ACCESS_DENIED."""
    for body in _error_bodies(error):
        for candidate in (body.get("detail"), body.get("error"), body):
            if isinstance(candidate, dict) and candidate.get("code") in RELAY_ERROR_CODES:
                out: dict[str, Any] = {"code": candidate["code"], "message": str(candidate.get("error") or "").strip(),
                                       "hint": str(candidate.get("hint") or "").strip()}
                out.update({k: candidate[k] for k in _RELAY_EXTRA_FIELDS if candidate.get(k) is not None})
                return out
    from .lockdown import is_degram

    status = _error_status(error) if is_degram() else None
    if status in STATUS_OUTCOME_CODES:
        return {"code": STATUS_OUTCOME_CODES[status], "message": _STATUS_OUTCOME_MESSAGES[status], "hint": ""}
    return None


def relay_error_summary(error: BaseException) -> str | None:
    """One line for ``result["error"]`` that starts with the outcome code, so the client can name the cause (D-18).
    None outside variant degram or when the error is not a relay outcome."""
    from .lockdown import is_degram

    if not is_degram():
        return None
    outcome = relay_outcome(error)
    if outcome is None:
        return None
    parts = [outcome["code"] + ":", outcome["message"] or "the DG relay refused the request."]
    extras = [f"{key}: {outcome[key]}" for key in _RELAY_EXTRA_FIELDS if key in outcome]
    if extras:
        parts.append("(" + ", ".join(extras) + ")")
    if outcome["hint"]:
        parts.append(outcome["hint"])
    return " ".join(parts)


def named_outcome_copy(summary: str) -> str | None:
    """The chat copy of a terminal failure whose summary already leads with a relay outcome code
    (``relay_error_summary``): the summary itself, so the stock "rejected this request as malformed" sentence never
    mislabels a policy deny or a timeout. None outside variant degram or for any other summary."""
    from .lockdown import is_degram

    named = RELAY_ERROR_CODES | frozenset(STATUS_OUTCOME_CODES.values())
    if is_degram() and isinstance(summary, str) and summary.split(":", 1)[0] in named:
        return summary
    return None


def terminal_verdict(error: BaseException) -> dict[str, Any] | None:
    """Classifier verdict for a named failure, else None.

    A named credential failure anywhere in the cause chain (CREDENTIALS_MISSING/EXPIRED): ``auth_permanent`` + not
    retryable + no rotate/fallback, so the turn stops at once and the client sees the CREDENTIALS_* code instead of three
    backoff retries. A named relay outcome (POLICY_DENY, PROVIDER_TIMEOUT, ...): terminal as well (``format_error``,
    not retryable, no fallback): the user gets the cause and a Retry button, never an automatic second call."""
    from .credentials import DegramCredentialsError

    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, DegramCredentialsError):
            from agent.error_classifier import FailoverReason
            return {"reason": FailoverReason.auth_permanent, "retryable": False,
                    "should_rotate_credential": False, "should_fallback": False}
        current = current.__cause__ or current.__context__
    outcome = relay_outcome(error)
    if outcome is not None:
        from agent.error_classifier import FailoverReason
        if outcome["code"] in STATUS_OUTCOME_CODES.values():
            return {"reason": FailoverReason.auth_permanent, "retryable": False, "should_compress": False,
                    "should_rotate_credential": False, "should_fallback": False}
        return {"reason": FailoverReason.format_error, "retryable": False, "should_compress": False,
                "should_rotate_credential": False, "should_fallback": False}
    return None
