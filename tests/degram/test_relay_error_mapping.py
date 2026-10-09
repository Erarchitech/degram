"""Variant degram: a relay 401/403 without a named code reaches the renderer as a named DeGram outcome (1301-19, G-4).

The 0.1.5 run showed the stock "custom rejected your API key" card for a relay refusal. The relay's own refusal must
lead with CREDENTIALS_INVALID (401) or ACCESS_DENIED (403) so ``parseFailureText`` finds a code and the renderer
never falls through to the stock auth/api_key surface. Outside variant degram nothing changes.
"""

from __future__ import annotations

import pytest

from degram_variant.provider import (
    named_outcome_copy,
    relay_error_summary,
    relay_outcome,
    terminal_verdict,
)


class _Response:
    def __init__(self, status_code, body=None):
        self.status_code = status_code
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


class _StatusError(Exception):
    """Shape of an SDK ``APIStatusError``: ``status_code``, ``body``, ``response``."""

    def __init__(self, status_code, body=None, message="Error code"):
        super().__init__(message)
        self.status_code = status_code
        self.body = body
        self.response = _Response(status_code, body)


@pytest.fixture
def degram(monkeypatch):
    monkeypatch.setenv("HERMES_DEGRAM", "1")


@pytest.mark.parametrize("status,code", [(401, "CREDENTIALS_INVALID"), (403, "ACCESS_DENIED")])
def test_an_unnamed_relay_refusal_gets_a_named_code(degram, status, code):
    error = _StatusError(status, body={"detail": "Not authenticated"})
    outcome = relay_outcome(error)
    assert outcome is not None and outcome["code"] == code
    summary = relay_error_summary(error)
    assert summary is not None and summary.startswith(code + ":")
    assert named_outcome_copy(summary) == summary
    # never the provider name, a key hint or a diagnostics suggestion
    for word in ("custom", "API key", "provider", "diagnostics"):
        assert word.lower() not in summary.lower()


def test_the_status_is_found_through_the_cause_chain(degram):
    try:
        try:
            raise _StatusError(401, body="<html>nope</html>")
        except _StatusError as inner:
            raise RuntimeError("wrapped") from inner
    except RuntimeError as outer:
        assert relay_outcome(outer)["code"] == "CREDENTIALS_INVALID"


def test_a_named_relay_code_wins_over_the_status(degram):
    body = {"detail": {"error": "DG policy does not allow this.", "code": "POLICY_DENY", "reason": "x"}}
    assert relay_outcome(_StatusError(403, body=body))["code"] == "POLICY_DENY"


@pytest.mark.parametrize("status", [400, 404, 429, 500, 502])
def test_other_statuses_are_not_relay_outcomes(degram, status):
    assert relay_outcome(_StatusError(status, body={"detail": "x"})) is None


@pytest.mark.parametrize("status", [401, 403])
def test_the_refusal_is_terminal_not_retried(degram, status):
    verdict = terminal_verdict(_StatusError(status, body={"detail": "no"}))
    assert verdict is not None
    assert verdict["retryable"] is False
    assert verdict["should_fallback"] is False and verdict["should_rotate_credential"] is False


@pytest.mark.parametrize("status", [401, 403])
def test_stock_variants_are_untouched(monkeypatch, status):
    monkeypatch.delenv("HERMES_DEGRAM", raising=False)
    error = _StatusError(status, body={"detail": "Not authenticated"})
    assert relay_outcome(error) is None
    assert relay_error_summary(error) is None
    assert named_outcome_copy("CREDENTIALS_INVALID: x") is None
    assert terminal_verdict(error) is None
