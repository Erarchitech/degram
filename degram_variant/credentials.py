"""In-memory delegated DG credential for variant degram (1301 D-06).

The delegated ``dgd_`` token is handed to the agent only through the gateway RPC
``degram.credentials.set`` and lives in this process' memory. It is never written to disk,
environment, logs or an LLM payload: the provider passes :meth:`DegramCredentials.api_key_provider`
(a callable) as ``api_key``, so the OpenAI SDK reads the *current* token on every request and
a renewal (``set`` again) or ``clear`` takes effect on the very next call.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

CREDENTIALS_MISSING = "CREDENTIALS_MISSING"
CREDENTIALS_EXPIRED = "CREDENTIALS_EXPIRED"
CREDENTIALS_INVALID = "CREDENTIALS_INVALID"

_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


class DegramCredentialsError(RuntimeError):
    """A named credential failure. ``code`` is the operational outcome the client sees."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


@dataclass(frozen=True)
class CredentialsInfo:
    """Everything except the token."""

    expires_at: float
    relay_base_url: str
    user: str
    company: str | None
    project: str


def _parse_expiry(value: Any) -> float:
    if isinstance(value, bool):
        raise DegramCredentialsError(CREDENTIALS_INVALID, "expiresAt must be an ISO-8601 time or epoch seconds")
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        text = value.strip()
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            raise DegramCredentialsError(CREDENTIALS_INVALID, "expiresAt is not a valid ISO-8601 time") from None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    raise DegramCredentialsError(CREDENTIALS_INVALID, "expiresAt must be an ISO-8601 time or epoch seconds")


def normalize_relay_base_url(value: Any) -> str:
    """The relay origin (and optional path prefix) without the ``/degram/v1`` suffix.

    http is accepted only for loopback hosts (a delegated token must not cross the network in clear);
    credentials, query and fragment in the URL are refused."""
    if not isinstance(value, str) or not value.strip():
        raise DegramCredentialsError(CREDENTIALS_INVALID, "relayBaseUrl is required")
    parts = urlsplit(value.strip())
    host = (parts.hostname or "").lower()
    if parts.scheme not in {"http", "https"} or not host:
        raise DegramCredentialsError(CREDENTIALS_INVALID, "relayBaseUrl must be an http(s) URL")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise DegramCredentialsError(CREDENTIALS_INVALID, "relayBaseUrl must not carry credentials, query or fragment")
    if parts.scheme == "http" and host not in _LOOPBACK_HOSTS:
        raise DegramCredentialsError(CREDENTIALS_INVALID, "relayBaseUrl must be https unless it is loopback")
    return f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/')}"


class DegramCredentials:
    """Thread-safe holder of the one delegated credential of this process."""

    def __init__(self, clock=time.time) -> None:
        self._lock = threading.Lock()
        self._clock = clock
        self._token: str | None = None
        self._info: CredentialsInfo | None = None

    # -- writers -------------------------------------------------------------------------------
    def set(self, *, token: Any, expires_at: Any, relay_base_url: Any, user: Any,
            company: Any = None, project: Any) -> CredentialsInfo:
        if not isinstance(token, str) or not token.strip():
            raise DegramCredentialsError(CREDENTIALS_INVALID, "token is required")
        if not isinstance(user, str) or not user.strip() or not isinstance(project, str) or not project.strip():
            raise DegramCredentialsError(CREDENTIALS_INVALID, "user and project are required")
        if company is not None and not isinstance(company, str):
            raise DegramCredentialsError(CREDENTIALS_INVALID, "company must be a string or null")
        info = CredentialsInfo(
            expires_at=_parse_expiry(expires_at),
            relay_base_url=normalize_relay_base_url(relay_base_url),
            user=user.strip(), company=(company.strip() or None) if isinstance(company, str) else None,
            project=project.strip())
        with self._lock:
            self._token, self._info = token.strip(), info
        return info

    def clear(self) -> None:
        with self._lock:
            self._token, self._info = None, None

    # -- readers -------------------------------------------------------------------------------
    def info(self) -> CredentialsInfo | None:
        """Scope and expiry; never the token."""
        with self._lock:
            return self._info

    def require_info(self) -> CredentialsInfo:
        info = self.info()
        if info is None:
            raise DegramCredentialsError(CREDENTIALS_MISSING, "no delegated DG credential is set")
        return info

    def api_key_provider(self) -> str:
        """The current token, or a named error: CREDENTIALS_MISSING after ``clear`` (or before ``set``),
        CREDENTIALS_EXPIRED once ``expiresAt`` has passed. Called by the SDK before every request."""
        with self._lock:
            token, info = self._token, self._info
        if token is None or info is None:
            raise DegramCredentialsError(CREDENTIALS_MISSING, "no delegated DG credential is set")
        if self._clock() >= info.expires_at:
            raise DegramCredentialsError(CREDENTIALS_EXPIRED, "the delegated DG credential has expired")
        return token

    # -- redaction -----------------------------------------------------------------------------
    def __repr__(self) -> str:
        info = self.info()
        return f"DegramCredentials(present={info is not None})"

    __str__ = __repr__

    def __reduce__(self):  # a pickled/copied store must not carry the token
        raise TypeError("DegramCredentials cannot be serialised")


credentials = DegramCredentials()

__all__ = [
    "CREDENTIALS_EXPIRED", "CREDENTIALS_INVALID", "CREDENTIALS_MISSING", "CredentialsInfo", "DegramCredentials",
    "DegramCredentialsError", "credentials", "normalize_relay_base_url",
]
