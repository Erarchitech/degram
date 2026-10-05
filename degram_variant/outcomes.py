"""Named operational outcomes of the DeGram read capabilities (1301 plan 11).

The vocabulary is closed and owned by the framework: ``spec/degram/OPERATIONAL-OUTCOMES.md`` (machine-checked
block) and ``data-service/degram_relay.py``. This module only *emits* codes from that set; a test reads the spec
block and fails if a code used here is not in it. An outcome says how a call went, never whether a design
satisfies a rule, and it carries no prompt text, key or project data."""

from __future__ import annotations

from typing import Any

# Bridge outcomes (plans 1301-06, 1301-07)
BRIDGE_OFF = "BRIDGE_OFF"
BUSY = "BUSY"
EXTENSION_NOT_LOADED = "EXTENSION_NOT_LOADED"
ROUTES_DISABLED = "ROUTES_DISABLED"
ROUTES_NOT_LOOPBACK = "ROUTES_NOT_LOOPBACK"
SETUP_INCOMPLETE = "SETUP_INCOMPLETE"
IDENTITY_MISMATCH = "IDENTITY_MISMATCH"
DOCUMENT_NOT_OPEN = "DOCUMENT_NOT_OPEN"
# Agent outcomes (plans 1301-10, 1301-11)
CANCELLED = "CANCELLED"
DEGRAM_LOCKED = "DEGRAM_LOCKED"
SCOPE_NOT_SUPPORTED = "SCOPE_NOT_SUPPORTED"
CONSENT_REQUIRED = "CONSENT_REQUIRED"
POLICY_DENY = "POLICY_DENY"
# DG backend reads (plan 1301-11): the graph / rules routes of the bound project
DG_UNAVAILABLE = "DG_UNAVAILABLE"
ACCESS_DENIED = "ACCESS_DENIED"

# Every code this component can put in an outcome. Checked against the spec block by tests/degram.
EMITTED_CODES = frozenset({
    BRIDGE_OFF, BUSY, EXTENSION_NOT_LOADED, ROUTES_DISABLED, ROUTES_NOT_LOOPBACK, SETUP_INCOMPLETE, IDENTITY_MISMATCH,
    DOCUMENT_NOT_OPEN, CANCELLED, DEGRAM_LOCKED, SCOPE_NOT_SUPPORTED, CONSENT_REQUIRED, POLICY_DENY, DG_UNAVAILABLE,
    ACCESS_DENIED, "CREDENTIALS_MISSING", "CREDENTIALS_EXPIRED",
})

# The UI-SPEC bridge states: ready, pinned, busy, off, setup-incomplete, identity-mismatch.
STATE_OFF, STATE_BUSY, STATE_SETUP, STATE_MISMATCH = "off", "busy", "setup-incomplete", "identity-mismatch"


def bridge_state(code: str | None, reason: str | None = None) -> str | None:
    """The scope-strip state for an outcome code, or None when the code is not a bridge state."""
    return {
        BRIDGE_OFF: STATE_OFF,
        BUSY: STATE_BUSY,
        SETUP_INCOMPLETE: STATE_SETUP, ROUTES_NOT_LOOPBACK: STATE_SETUP, ROUTES_DISABLED: STATE_SETUP,
        EXTENSION_NOT_LOADED: STATE_SETUP,
        IDENTITY_MISMATCH: STATE_MISMATCH, DOCUMENT_NOT_OPEN: STATE_MISMATCH,
    }.get(code or "")


class BridgeError(Exception):
    """A read that ended in a named operational outcome. ``reason`` keeps the specific cause (for
    ``SETUP_INCOMPLETE``: ROUTES_NOT_LOOPBACK, NO_DOCUMENT_OPEN, ...)."""

    def __init__(self, code: str, reason: str | None = None, message: str | None = None, **extra: Any) -> None:
        super().__init__(f"{code}: {message or reason or code}")
        self.code = code
        self.reason = reason
        self.message = message or reason or code
        self.extra = extra

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"status": "error", "code": self.code, "message": self.message}
        if self.reason:
            out["reason"] = self.reason
        state = bridge_state(self.code, self.reason)
        if state:
            out["bridgeState"] = state
        out.update(self.extra)
        return out
