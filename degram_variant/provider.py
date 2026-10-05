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


def terminal_verdict(error: BaseException) -> dict[str, Any] | None:
    """Classifier verdict for a named credential failure anywhere in the cause chain, else None.

    ``auth_permanent`` + not retryable + no rotate/fallback: the turn stops at once and the client
    sees the CREDENTIALS_* code instead of three backoff retries."""
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
    return None
