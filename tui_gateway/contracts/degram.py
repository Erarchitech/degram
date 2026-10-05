"""Contracts: variant degram credential handoff (Phase 1301 plan 10, D-06).

Handlers: ``tui_gateway/methods_degram.py``. The delegated token travels only in
``degram.credentials.set`` (Electron main -> loopback gateway), is held in process memory and is
never returned: ``degram.credentials.status`` answers presence, scope and expiry, never the token.
Field names are camelCase on purpose: they are the plan-12 handoff contract with Electron main.
"""

from __future__ import annotations

from .base import JsonValue, Params, Result
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


# -- CAD read capabilities (plan 1301-11, D-13..D-18) -----------------------------------------------
# An operational outcome is an ``ok`` result with ``status: "error"`` and a named ``code``
# (spec/degram/OPERATIONAL-OUTCOMES.md); a refused request (unknown or stale preview, bad scope) is a
# JSON-RPC error with ``error.data.code``.


class DegramOutcomeFields(Result):
    status: str
    code: str | None = None
    reason: str | None = None
    message: str | None = None
    bridgeState: str | None = None


class DegramDocumentsListResult(DegramOutcomeFields):
    groups: JsonValue = None  # [{app, state, documents: [{app, name, path, unsaved, identity, pinned}], code?, reason?}]
    pinned: JsonValue = None


class DegramDocumentsPinParams(Params):
    app: str | None = None  # null unpins
    identity: JsonValue = None


class DegramDocumentsPinResult(DegramOutcomeFields):
    pinned: JsonValue = None


class DegramContextPreviewParams(Params):
    scope: str = "selection"  # none | selection | whole-definition
    previewId: str | None = None  # client-chosen id so a cancel can name the read before it returns


class DegramContextPreviewResult(DegramOutcomeFields):
    previewId: str | None = None
    scope: str | None = None
    requestedScope: str | None = None
    requiresConsent: bool | None = None
    limits: JsonValue = None
    payload: str | None = None
    summary: JsonValue = None
    truncation: JsonValue = None
    missing: JsonValue = None
    document: JsonValue = None


class DegramContextSendParams(Params):
    session_id: str
    previewId: str
    text: str
    consent: bool = False
    scope: str | None = None


class DegramContextSendResult(DegramOutcomeFields):
    previewId: str | None = None
    scope: str | None = None
    bytes: int | None = None
    submit: JsonValue = None


class DegramContextCancelParams(Params):
    previewId: str | None = None  # null cancels every in-flight read


class DegramContextCancelResult(DegramOutcomeFields):
    cancelled: int = 0


method("degram.documents.list", params=Params, result=DegramDocumentsListResult,
       doc="Open documents of every reachable CAD bridge with a state per bridge; pins nothing.")
method("degram.documents.pin", params=DegramDocumentsPinParams, result=DegramDocumentsPinResult,
       doc="Pin one open document by identity (app null unpins). Outcomes: DOCUMENT_NOT_OPEN, BRIDGE_OFF, BUSY.")
method("degram.context.preview", params=DegramContextPreviewParams, result=DegramContextPreviewResult,
       doc="Read the pinned document and return the exact bounded context payload with its disclosure.")
method("degram.context.send", params=DegramContextSendParams, result=DegramContextSendResult,
       doc="Submit a turn whose message embeds the previewed payload byte for byte. Whole-definition needs consent true.")
method("degram.context.cancel", params=DegramContextCancelParams, result=DegramContextCancelResult,
       doc="Abort the in-flight bridge read of a preview (or every read); the preview resolves with CANCELLED.")
