"""Contracts: variant degram credential handoff (Phase 1301 plan 10, D-06), CAD reads (plan 11) and the Mapping
sub-tab (Phase 1303-10).

Handlers: ``tui_gateway/methods_degram.py``. The delegated token travels only in
``degram.credentials.set`` (Electron main -> loopback gateway), is held in process memory and is
never returned: ``degram.credentials.status`` answers presence, scope and expiry, never the token.
Field names are camelCase on purpose: they are the plan-12 handoff contract with Electron main.
"""

from __future__ import annotations

from typing import Literal

from .base import JsonValue, Params, Result
from .registry import method


class DegramEnvironmentBarrierParams(Params):
    environmentId: str
    generation: int


class DegramEnvironmentBarrierResult(Result):
    ok: bool = True


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


method("degram.environment.quiesce", params=DegramEnvironmentBarrierParams, result=DegramEnvironmentBarrierResult,
       doc="Fail closed unless the local DeGram backend has no active work, then reject new work for this generation.")
method("degram.environment.resume", params=DegramEnvironmentBarrierParams, result=DegramEnvironmentBarrierResult,
       doc="Reopen only the exact generation quiesced before an aborted pre-persistence environment switch.")
method("degram.environment.assert_active", params=DegramEnvironmentBarrierParams, result=DegramEnvironmentBarrierResult,
       doc="Reject a target-bound request while its backend generation is quiesced for an environment switch.")
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


# -- Mapping sub-tab of «Модели» (Phase 1303-10, 1303-API-CONTRACT.md §2, §3, §7) ---------------------
# Sessions, answers and undo go to DG with the delegated token of the bound project; start and focus go to the
# Grasshopper canvas bridge (app grasshopper, the default) or to the DG Revit connector's MCP tools (app revit,
# 1303-API-CONTRACT.md §8.5). A request DG refuses for what it is (HTTP 400/404/409) is a JSON-RPC error whose
# data.code is DG's code (MAPPING_SESSION_APPLIED, MAPPING_ANSWER_NOT_FOUND, ...) and data.status the HTTP status.


class DegramMappingSessionsParams(Params):
    document: str | None = None  # a document name (file name); null lists every session of the project
    # grasshopper: the canvas names the document key first (get_mapping_status); revit: the key of the document name,
    # plus the connector status (dg_mapping_status)
    app: str | None = None


class DegramMappingSessionsResult(DegramOutcomeFields):
    document: str | None = None  # the document key the rows were matched by
    sessions: JsonValue = None  # [{sessionId, label, document, platform, createdAt, summary, appliedAt?}], newest first
    # with a document only, absent when the connector did not answer: CONNECTOR is on the canvas / the Revit connector
    # answered, it is signed in (a start can work), its open session and its last message
    connector: bool | None = None
    signedIn: bool | None = None
    connectorSessionId: str | None = None
    connectorMessage: str | None = None


class DegramMappingSessionParams(Params):
    sessionId: str


class DegramMappingSessionResult(DegramOutcomeFields):
    session: JsonValue = None  # the MappingSession without elements, groups, parameters and measures


class DegramMappingAnswerParams(Params):
    sessionId: str
    questionId: str
    optionId: str
    groupIds: list[str] | None = None  # batch-assign: the subset of groups to accept


class DegramMappingUndoParams(Params):
    sessionId: str
    answerId: str


class DegramMappingApplyParams(Params):
    sessionId: str
    requestId: str
    revision: str
    answerIds: list[str]
    # 1303-35: the reference of the member's native-confirmed advanced-commit intent; advanced or mixed work needs it
    intentId: str | None = None
    # DG 1303-31 (D-106): the confirmed name of the Design State a Revit confirmation records
    designStateName: str | None = None
    designStateNameSource: str | None = None


class DegramMappingSuggestNameParams(Params):
    sessionId: str
    answerIds: list[str] = []
    language: str | None = None


class DegramMappingSuggestNameResult(DegramOutcomeFields):
    suggestion: JsonValue = None  # {name, source: llm | fallback}; DG records nothing


class DegramMappingApplyResult(DegramOutcomeFields):
    batch: JsonValue = None  # immutable confirmation metadata, not proof of a CAD write


class DegramMappingStartParams(Params):
    app: str | None = None  # grasshopper (default): CONNECTOR start_mapping; revit: the connector's dg_start_mapping
    # revit only (DG 1303-33, D-123, D-124): the filters that are on ({view?: "active" | name | id, selection?: true,
    # categories?: [OST_*]}, intersected; {} reads the whole model; absent: the selection, else the active view), the
    # element limit 1..5000 and the continuation after an over-limit start (the lastElementId it answered)
    filters: JsonValue = None
    limit: int | None = None
    after: int | None = None


class DegramMappingStartResult(DegramOutcomeFields):
    started: bool | None = None
    sessionId: str | None = None  # revit only: the session the connector just created
    scope: str | None = None  # revit only: "selection" (only the selected elements were read), "view" or "filters"
    read: int | None = None  # revit only: elements sent to DG
    matched: int | None = None  # revit, filters: elements that pass the filters
    remaining: int | None = None  # revit, filters: elements left beyond the limit (continue with after)
    lastElementId: int | None = None  # revit, filters: the ElementId to continue after


class DegramMappingFiltersParams(Params):
    app: str | None = None  # revit (the only application with mapping filters)


class DegramMappingFiltersResult(DegramOutcomeFields):
    categories: JsonValue = None  # [{name: OST_*, label, count}] model categories that can hold DG_Class
    views: JsonValue = None  # [{id, name, type}] views a View filter can name


class DegramMappingFocusParams(Params):
    app: str | None = None  # grasshopper (default) needs componentId; revit needs sessionId and itemId
    componentId: str | None = None  # the Grasshopper InstanceGuid of the item (32 hex)
    sessionId: str | None = None  # revit: the session the row belongs to
    itemId: str | None = None  # revit: the row's group id; its elements' UniqueIds are selected and zoomed to


class DegramMappingFocusResult(DegramOutcomeFields):
    found: bool | None = None  # revit: at least one element of the group is in the model
    componentId: str | None = None
    name: str | None = None
    itemId: str | None = None  # revit only
    shown: int | None = None  # revit only: elements selected and zoomed to
    missing: list[str] | None = None  # revit only: UniqueIds the model does not hold


class DegramRestateParams(Params):
    stateId: str | None = None  # the Design State of the Model Viewer tile (model snapshot or computed state id)


class DegramRestateResult(DegramOutcomeFields):
    connector: str | None = None  # revit | grasshopper
    stateId: str | None = None
    # revit: {moved, unchanged, skipped, missing, failed, details}; grasshopper: {applied, aborted, parameters, details}
    report: JsonValue = None


# -- Advanced Revit mapping (1303-35, R10): exactly six names, no wildcard ---------------------------------------------
# Every protected action takes the REFERENCE (intentId and the scope echo) of a member's native-confirmed intent. There
# is no field that could carry a confirmation (``confirmed``, ``byAgent``, ``actor``): params models are closed, so such
# a key answers 4000 before any handler runs. ``project`` is never a parameter (the delegated credential's project is
# the only one) and neither is a tool name, URL or method.


class DegramMappingAdvancedAnswerParams(Params):
    sessionId: str
    requestId: str  # the idempotency key of this answer: a retry reuses it
    intentId: str  # the confirmed approve/skip intent the main process issued for this member
    action: Literal["approve", "skip"]
    scope: JsonValue  # the intent's own scope (definitionId, definitionVersion, resultHash, bindingRevision, ...)


class DegramMappingAdvancedAnswersParams(Params):
    sessionId: str
    requestId: str
    intentId: str
    scope: JsonValue


class DegramMappingAdvancedDeriveParams(Params):
    sessionId: str
    definitionId: str
    requestId: str  # names the frozen derive request; a retry or a status read reuses it
    definitionVersion: int | None = None
    expectedBindingRevision: int | None = None
    binding: dict[str, JsonValue] | None = None  # model-local correction; DG validates closed keys per kind
    statusOnly: bool = False  # read the status of requestId; ask nothing of Revit


class DegramMappingAdvancedPreviewParams(Params):
    sessionId: str
    intentId: str  # the confirmed preview-definition (or clear-definition-preview) intent


class DegramMappingAdvancedModeParams(Params):
    definitionId: str
    mode: Literal["ordinary", "advanced"]
    expectedRevision: int  # compare-and-set on the definition revision
    reason: str | None = None


class DegramMappingAdvancedConfirmIntentParams(Params):
    sessionId: str  # routes the status read; it grants nothing
    intentId: str  # the pending challenge to show in the native dialog
    scope: JsonValue  # the challenge's own scope, echoed so a different one is refused before the dialog


class DegramAdvancedOutcomeFields(DegramOutcomeFields):
    # an unresolved outcome (a timeout or a cancel after a native step may have begun): read the status, never repeat it
    unresolved: bool | None = None
    statusLink: JsonValue = None  # {route, sessionId, intentId | requestId}
    intent: JsonValue = None  # the challenge as DG knows it: {intentId, action, status, ...}; never a proof secret
    tool: str | None = None


class DegramMappingAdvancedDeriveResult(DegramAdvancedOutcomeFields):
    requestId: str | None = None
    requestHash: str | None = None
    definitionId: str | None = None
    bindingRevision: int | None = None
    outcome: str | None = None  # ok | failed | needs-input | pending | unresolved | unknown
    ok: bool | None = None
    resultStatus: str | None = None
    resultHash: str | None = None
    change: str | None = None  # new | unchanged | changed | none
    nativeCode: str | None = None
    nativeMessage: str | None = None


class DegramMappingAdvancedModeResult(DegramAdvancedOutcomeFields):
    definition: JsonValue = None  # the PublicDefinition: the approved version and the pending proposal side by side


class DegramMappingAdvancedIntentResult(DegramAdvancedOutcomeFields):
    outcome: str | None = None  # confirmIntent: confirmed | cancelled; preview/clear: the native step's outcome
    decision: str | None = None  # confirmIntent only: the exact word the dialog answered, else cancelled
    operationId: str | None = None
    result: JsonValue = None  # the native step's own report, size capped


method("degram.mapping.sessions", params=DegramMappingSessionsParams, result=DegramMappingSessionsResult,
       doc="Mapping sessions of the bound project, newest first; only those of one document when document is given. "
           "Outcomes: ACCESS_DENIED, DG_UNAVAILABLE, CREDENTIALS_MISSING.")
method("degram.mapping.session", params=DegramMappingSessionParams, result=DegramMappingSessionResult,
       doc="One mapping session (summary, questions with items, answers, llm). Errors: MAPPING_SESSION_NOT_FOUND.")
method("degram.mapping.answer", params=DegramMappingAnswerParams, result=DegramMappingSessionResult,
       doc="Answer one proposal; returns the recomputed session. Errors: MAPPING_QUESTION_NOT_FOUND, "
           "MAPPING_OPTION_INVALID.")
method("degram.mapping.undo", params=DegramMappingUndoParams, result=DegramMappingSessionResult,
       doc="Take one answer back; returns the recomputed session. Errors: MAPPING_SESSION_APPLIED, "
           "MAPPING_ANSWER_NOT_FOUND.")
method("degram.mapping.apply", params=DegramMappingApplyParams, result=DegramMappingApplyResult,
       doc="Explicitly confirm the pending accepted answer ids at the given revision. Retries reuse requestId. "
           "DG enforces existing permissions; ACCESS_DENIED does not grant delegated apply. "
           "Errors: MAPPING_COMMIT_REQUIRED, MAPPING_COMMIT_CONFLICT. Queued is not a CAD write receipt.")
method("degram.mapping.suggestName", params=DegramMappingSuggestNameParams, result=DegramMappingSuggestNameResult,
       doc="DG 1303-31 (D-107): DG's suggested name of the Design State a Revit mapping confirmation records "
           "(the LLM from the classes and changes, or a deterministic name); the user confirms or replaces it. "
           "Records nothing.")
method("degram.mapping.start", params=DegramMappingStartParams, result=DegramMappingStartResult,
       doc="Create a mapping session from the CAD model now: CONNECTOR reads the Grasshopper canvas (bridge "
           "start_mapping), or with app revit the DG Revit connector reads the active model (dg_start_mapping). "
           "Outcomes: BRIDGE_OFF, BUSY, EXTENSION_NOT_LOADED, SETUP_INCOMPLETE.")
method("degram.mapping.filters", params=DegramMappingFiltersParams, result=DegramMappingFiltersResult,
       doc="DG 1303-33 (D-123): the model categories that can hold DG_Class (with counts) and the views a View filter "
           "can name, read from the open Revit model through the DG Revit connector. Outcomes: BRIDGE_OFF, BUSY, "
           "EXTENSION_NOT_LOADED, SETUP_INCOMPLETE.")
method("degram.mapping.advanced.answer", params=DegramMappingAdvancedAnswerParams,
       result=DegramMappingSessionResult,
       doc="1303-35: approve or skip one advanced class as a DRAFT answer under the reference of a member's "
           "native-confirmed intent for exactly this action and scope; returns the recomputed session with its "
           "advancedState. Errors: INTENT_NOT_CONFIRMED, INTENT_HASH_CONFLICT, ADVANCED_ANSWER_STALE.")
method("degram.mapping.advanced.answers", params=DegramMappingAdvancedAnswersParams,
       result=DegramMappingSessionResult,
       doc="Atomically approve the complete frozen definition list under one confirmed human intent.")
method("degram.mapping.advanced.derive", params=DegramMappingAdvancedDeriveParams,
       result=DegramMappingAdvancedDeriveResult,
       doc="1303-35: freeze one canonical read-only derive request in DG, let the DG Revit connector derive and post "
           "its own result, and read the outcome back (ok, failed, needs-input, pending, unresolved). statusOnly reads "
           "the status of requestId and asks Revit nothing; a timeout is unresolved and is never retried.")
method("degram.mapping.advanced.preview", params=DegramMappingAdvancedPreviewParams,
       result=DegramMappingAdvancedIntentResult,
       doc="1303-35 (broker): run the native preview of a definition for a confirmed preview-definition intent, "
           "once. A timeout is an unresolved outcome with a status link, never a second native call.")
method("degram.mapping.advanced.clearPreview", params=DegramMappingAdvancedPreviewParams,
       result=DegramMappingAdvancedIntentResult,
       doc="1303-35 (broker): remove that definition's own preview for a confirmed clear-definition-preview intent, "
           "once. Never a generic delete.")
method("degram.mapping.advanced.mode", params=DegramMappingAdvancedModeParams, result=DegramMappingAdvancedModeResult,
       doc="1303-35: propose the class mode (ordinary or advanced) as a compare-and-set proposal; the effective mode "
           "and any approved instance stay until a member confirms at the common commit. Errors: "
           "MAPPING_DEFINITION_CONFLICT.")
method("degram.mapping.advanced.confirmIntent", params=DegramMappingAdvancedConfirmIntentParams,
       result=DegramMappingAdvancedIntentResult,
       doc="1303-35 (broker): show a pending challenge the main process issued for this member in the native Revit "
           "dialog. Only a person pressing Yes confirms; Cancel grants nothing. It accepts the intent id and the "
           "scope echo only: it cannot create a member intent or set confirmed.")
method("degram.restate", params=DegramRestateParams, result=DegramRestateResult,
       doc="Restate a Design State of the Model Viewer (1303-29): DG answers the state's recorded placements or "
           "ParamState; Revit gets them through the DG Revit connector (dg_restate, one transaction, moves and "
           "rotations only), Grasshopper through the canvas bridge (restate_parameters, all or nothing). Errors: "
           "RESTATE_NOT_AVAILABLE. Outcomes: BRIDGE_OFF, BUSY, EXTENSION_NOT_LOADED, SETUP_INCOMPLETE, ACCESS_DENIED, "
           "DG_UNAVAILABLE.")
method("degram.mapping.focus", params=DegramMappingFocusParams, result=DegramMappingFocusResult,
       doc="Show one item in its CAD application: bring the Grasshopper editor forward, select one component and zoom "
           "to it (bridge focus_component), or with app revit select the elements of one session group in Revit and "
           "zoom the active view to them (dg_show_elements).")
