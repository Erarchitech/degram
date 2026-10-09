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


class DegramDocumentsListParams(Params):
    app: str | None = None  # one bridge only (the picker loads each group independently); null lists every bridge


class DegramDocumentsListResult(DegramOutcomeFields):
    groups: JsonValue = None  # [{app, state, documents: [{app, name, path, unsaved, identity, pinned}], code?, reason?}]
    pinned: JsonValue = None  # {app: {app, name, path, unsaved, identity}}: one pinned document per bridge (D-29)


class DegramDocumentsPinParams(Params):
    app: str | None = None  # the bridge this document belongs to; pinning replaces only that bridge's pin (null: unpin all)
    identity: JsonValue = None


class DegramDocumentsPinResult(DegramOutcomeFields):
    pinned: JsonValue = None  # the pinned document just recorded ({app, name, path, unsaved, identity})


class DegramDocumentsUnpinParams(Params):
    app: str | None = None  # the bridge whose pin to forget; null forgets every pin


class DegramDocumentsUnpinResult(DegramOutcomeFields):
    pinned: JsonValue = None  # what is still pinned: {app: document}


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
    summary: JsonValue = None  # {project, documents: [{app, name, path, objects, parameters, truncated, emptySelection}], rules, fragments, bytes, excluded}
    truncation: JsonValue = None
    missing: JsonValue = None
    documents: JsonValue = None  # the pinned documents the payload names, one per bridge


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


method("degram.documents.list", params=DegramDocumentsListParams, result=DegramDocumentsListResult,
       doc="Open documents of every reachable CAD bridge (or of one bridge: app) with a state per bridge; pins nothing.")
method("degram.documents.pin", params=DegramDocumentsPinParams, result=DegramDocumentsPinResult,
       doc="Pin one open document by identity; it replaces only that bridge's pin (one pinned document per bridge). "
           "Outcomes: DOCUMENT_NOT_OPEN, BRIDGE_OFF, BUSY.")
method("degram.documents.unpin", params=DegramDocumentsUnpinParams, result=DegramDocumentsUnpinResult,
       doc="Forget the pinned document of one bridge (app) or of every bridge (app null); nothing else changes.")
method("degram.context.preview", params=DegramContextPreviewParams, result=DegramContextPreviewResult,
       doc="Read every pinned document (one per bridge) and return the exact bounded context payload with its "
           "disclosure; a bridge that cannot be read is listed in summary.excluded.")
method("degram.context.send", params=DegramContextSendParams, result=DegramContextSendResult,
       doc="Submit a turn whose message embeds the previewed payload byte for byte. Whole-definition needs consent true.")
method("degram.context.cancel", params=DegramContextCancelParams, result=DegramContextCancelResult,
       doc="Abort the in-flight bridge read of a preview (or every read); the preview resolves with CANCELLED.")
