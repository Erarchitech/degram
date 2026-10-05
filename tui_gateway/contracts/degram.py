"""Contracts: variant degram credential handoff (Phase 1301 plan 10, D-06).

Handlers: ``tui_gateway/methods_degram.py``. The delegated token travels only in
``degram.credentials.set`` (Electron main -> loopback gateway), is held in process memory and is
never returned: ``degram.credentials.status`` answers presence, scope and expiry, never the token.
Field names are camelCase on purpose: they are the plan-12 handoff contract with Electron main.
"""

from __future__ import annotations

from .base import Params, Result
from .registry import method


class DegramCredentialsSetParams(Params):
    token: str
    expiresAt: str | float
    relayBaseUrl: str
    user: str
    company: str | None = None
    project: str


class DegramCredentialsStatusResult(Result):
    present: bool
    expired: bool = False
    expiresAt: float | None = None
    relayBaseUrl: str | None = None
    user: str | None = None
    company: str | None = None
    project: str | None = None


class DegramCredentialsSetResult(Result):
    ok: bool = True
    expiresAt: float


class DegramCredentialsClearResult(Result):
    ok: bool = True


method("degram.credentials.set", params=DegramCredentialsSetParams, result=DegramCredentialsSetResult,
       doc="Store the delegated DG token in process memory (variant degram only). Errors: CREDENTIALS_INVALID.")
method("degram.credentials.clear", params=Params, result=DegramCredentialsClearResult,
       doc="Wipe the delegated DG token; the next provider call fails with CREDENTIALS_MISSING.")
method("degram.credentials.status", params=Params, result=DegramCredentialsStatusResult,
       doc="Presence, scope and expiry of the delegated credential; never the token.")
