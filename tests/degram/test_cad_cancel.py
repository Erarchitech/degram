"""Cancellation, deadlines, whole-definition consent and relay outcomes (plan 1301-11 task 3; D-17, D-18, 1300 D-10).

Fake GH listener, fake stdio Revit adapter, fake DG backend and fake relay only; the turn tests drive a real agent."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest

import tui_gateway.server as server
from degram_variant import gh_bridge, relay_headers
from degram_variant.credentials import credentials

from .conftest import GH_PIN, PROJECT, TOKEN
from .fakes import FakeRelay, gh_identity
from .test_revit_bridge import REVIT_PIN, adapter  # noqa: F401  (fixture)


def _hdr(headers: dict, name: str):
    return next((v for k, v in headers.items() if k.lower() == name.lower()), None)


@pytest.fixture
def agent_home(rt):
    from hermes_constants import get_hermes_home
    lines = ["auxiliary:", "  title_generation:", "    model_upgrade_enabled: false", ""]
    (Path(get_hermes_home()) / "config.yaml").write_text("\n".join(lines), encoding="utf-8")


def _rpc(method, params=None, rid=1):
    return server.handle_request({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})


def _run_preview(rt, scope, preview_id):
    box = {}
    thread = threading.Thread(target=lambda: box.update(view=rt.composer.preview(scope, preview_id=preview_id)))
    thread.start()
    return thread, box


def _wait(predicate, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class TestCancelBridgeReads:
    def test_cancel_closes_the_gh_socket_and_resolves_cancelled_within_a_second(self, rt, gh):
        rt.documents.pin(**GH_PIN)
        gh.silent = True
        gh.requests.clear()
        before = gh.connections
        thread, box = _run_preview(rt, "selection", "pv_gh_cancel")
        assert _wait(lambda: gh.requests), "the read never reached the fake listener"
        started = time.monotonic()
        reply = _rpc("degram.context.cancel", {"previewId": "pv_gh_cancel"})["result"]
        thread.join(timeout=3)
        elapsed = time.monotonic() - started
        assert not thread.is_alive() and elapsed < 1.0, f"cancel took {elapsed:.2f}s"
        assert reply["status"] == "ok" and reply["cancelled"] == 1
        assert box["view"]["status"] == "error" and box["view"]["code"] == "CANCELLED"
        assert gh.client_closed.wait(2), "the client must close the socket"
        assert gh.connections == before + 1, "no retry"

    def test_cancel_abandons_the_revit_mcp_call_within_a_second(self, rt, adapter):  # noqa: F811
        rt.documents.pin(**REVIT_PIN)
        adapter.mode(mode="hang")
        thread, box = _run_preview(rt, "selection", "pv_revit_cancel")
        assert _wait(lambda: any(c["tool"] == "get_selection_snapshot" for c in adapter.calls()))
        started = time.monotonic()
        _rpc("degram.context.cancel", {"previewId": "pv_revit_cancel"})
        thread.join(timeout=3)
        elapsed = time.monotonic() - started
        assert not thread.is_alive() and elapsed < 1.0, f"cancel took {elapsed:.2f}s"
        assert box["view"]["code"] == "CANCELLED"
        assert len([c for c in adapter.calls() if c["tool"] == "get_selection_snapshot"]) == 1, "no retry"

    def test_cancel_without_an_id_cancels_every_in_flight_read(self, rt, gh):
        rt.documents.pin(**GH_PIN)
        gh.silent = True
        gh.requests.clear()
        thread, box = _run_preview(rt, "selection", "pv_all")
        assert _wait(lambda: gh.requests)
        assert _rpc("degram.context.cancel", {})["result"]["cancelled"] == 1
        thread.join(timeout=3)
        assert box["view"]["code"] == "CANCELLED"

    def test_cancel_of_an_unknown_preview_is_a_no_op(self, rt):
        assert _rpc("degram.context.cancel", {"previewId": "pv_nothing"})["result"]["cancelled"] == 0

    def test_a_cancelled_read_leaves_no_interrupt_bit_on_the_thread(self, rt, gh):
        from tools.interrupt import is_thread_interrupted
        rt.documents.pin(**GH_PIN)
        gh.silent = True
        gh.requests.clear()
        seen = {}

        def work():
            seen["tid"] = threading.get_ident()
            seen["view"] = rt.composer.preview("selection", preview_id="pv_bit")

        thread = threading.Thread(target=work)
        thread.start()
        assert _wait(lambda: gh.requests)
        rt.composer.cancel("pv_bit")
        thread.join(timeout=3)
        assert seen["view"]["code"] == "CANCELLED"
        assert not is_thread_interrupted(seen["tid"])


class TestDeadlinesAndNoRetry:
    def test_a_gh_read_with_no_answer_for_30_seconds_is_busy(self, rt, gh, monkeypatch):
        rt.documents.pin(**GH_PIN)
        gh.silent = True
        gh.requests.clear()
        before = gh.connections
        monkeypatch.setattr(gh_bridge, "_monotonic", lambda: time.monotonic() + (31.0 if gh.requests else 0.0))
        started = time.monotonic()
        view = rt.composer.preview("selection")
        assert view["status"] == "error" and view["code"] == "BUSY" and view["bridgeState"] == "busy"
        assert time.monotonic() - started < 5, "the clock is patched, the test must not wait 30 s"
        assert gh.connections == before + 1, "no retry"

    def test_connect_refused_is_bridge_off_with_a_single_attempt(self, rt, gh, monkeypatch):
        from .fakes import free_port
        rt.documents.pin(**GH_PIN)
        before = gh.connections
        monkeypatch.setattr(gh_bridge, "GH_PORT", free_port())
        view = rt.composer.preview("selection")
        assert view["code"] == "BRIDGE_OFF" and view["bridgeState"] == "off"
        assert gh.connections == before, "the refused port is not the fake listener"

    def test_the_deadline_constants_are_the_plan_values(self):
        from degram_variant import revit_bridge
        assert gh_bridge.READ_TIMEOUT_S == 30.0 and gh_bridge.CONNECT_TIMEOUT_S == 2.0
        assert revit_bridge.REVIT_DEADLINE_S == 40.0


def _arm_relay(relay):
    credentials.set(token=TOKEN, expires_at=time.time() + 600, relay_base_url=relay.base, user="alice", company="acme",
                    project=PROJECT)


class TestSessionInterrupt:
    def test_interrupting_a_turn_cancels_the_tool_driven_bridge_read(self, rt, gh, agent_home):
        relay = FakeRelay(script=[{"text": "Let me look. ", "tool": "degram_document_snapshot"},
                                  {"text": "never reached"}])
        try:
            rt.documents.pin(**GH_PIN)
            _arm_relay(relay)
            gh.silent = True
            gh.requests.clear()
            before = gh.connections
            agent = server._make_agent("sid-int", "key-int")
            box = {}
            turn = threading.Thread(target=lambda: box.update(result=agent.run_conversation("look at my selection")))
            turn.start()
            assert _wait(lambda: gh.requests, 15), "the tool never reached the bridge"
            started = time.monotonic()
            agent.interrupt("stop")
            assert gh.client_closed.wait(3), "the bridge read must be abandoned (socket closed)"
            turn.join(timeout=10)
            assert not turn.is_alive(), "the turn must end after the interrupt"
            assert time.monotonic() - started < 5
            result = box["result"]
            assert result.get("interrupted") is True
            assert len(relay.chat_posts()) == 1, "no follow-up model call after the interrupt"
            assistant = [m for m in result["messages"] if m.get("role") == "assistant"]
            assert any("Let me look." in (m.get("content") or "") for m in assistant), "partial text is kept"
            assert gh.connections == before + 1, "no retry of the read"
        finally:
            relay.close()


class TestWholeDefinitionConsent:
    def _preview(self, rt):
        rt.documents.pin(**GH_PIN)
        view = rt.composer.preview("whole-definition")
        assert view["status"] == "ok" and view["requiresConsent"] is True
        return view

    def _turn(self, relay, text):
        agent = server._make_agent("sid-consent", "key-consent")
        return agent.run_conversation(text)

    def test_without_consent_the_composer_refuses_locally_and_nothing_is_sent(self, rt, agent_home):
        from degram_variant.outcomes import BridgeError
        relay = FakeRelay()
        try:
            view = self._preview(rt)
            _arm_relay(relay)
            with pytest.raises(BridgeError) as exc:
                rt.composer.prepare_send(view["previewId"], "check height")
            assert exc.value.code == "CONSENT_REQUIRED"
            with pytest.raises(BridgeError):
                rt.composer.prepare_send(view["previewId"], "check height", consent=False)
            assert relay_headers.current() is None, "a refused send must not arm any context"
            assert relay.requests == []
        finally:
            relay.close()

    def test_the_rpc_refuses_without_consent_and_never_submits(self, rt, monkeypatch):
        view = self._preview(rt)
        submitted = []
        monkeypatch.setitem(server._methods, "prompt.submit", lambda rid, p: submitted.append(p) or server._ok(rid, {}))
        reply = _rpc("degram.context.send", {"session_id": "s", "previewId": view["previewId"], "text": "x"})["result"]
        assert reply["status"] == "error" and reply["code"] == "CONSENT_REQUIRED"
        assert submitted == []
        ok = _rpc("degram.context.send", {"session_id": "s", "previewId": view["previewId"], "text": "x",
                                          "consent": True})["result"]
        assert ok["status"] == "ok" and ok["scope"] == "whole-definition" and len(submitted) == 1
        assert submitted[0]["_degram_send"] is relay_headers.SEND_TICKET

    def test_with_consent_the_relay_gets_the_scope_and_consent_headers(self, rt, agent_home):
        relay = FakeRelay()
        try:
            view = self._preview(rt)
            _arm_relay(relay)
            plan = rt.composer.prepare_send(view["previewId"], "check height", consent=True)
            assert plan.scope == "whole-definition" and plan.consent is True
            result = self._turn(relay, plan.message)
            assert result["final_response"] == "hello"
            (post,) = relay.chat_posts()
            assert _hdr(post["headers"], "X-DeGram-Context-Scope") == "whole-definition"
            # the relay accepts only "true" or "1" (data-service/degram_relay.py _CONSENT_VALUES)
            assert _hdr(post["headers"], "X-DeGram-Whole-Definition-Consent") == "true"
            assert post["body"]["messages"][-1]["content"].startswith(view["payload"])
        finally:
            relay.close()

    def test_a_later_plain_message_never_inherits_the_consent(self, rt, agent_home):
        relay = FakeRelay()
        try:
            view = self._preview(rt)
            _arm_relay(relay)
            rt.composer.prepare_send(view["previewId"], "check height", consent=True)
            relay_headers.on_prompt_submit({})  # any prompt.submit that is not degram.context.send
            self._turn(relay, "and another thing")
            (post,) = relay.chat_posts()
            assert _hdr(post["headers"], "X-DeGram-Context-Scope") == "none"
            assert _hdr(post["headers"], "X-DeGram-Whole-Definition-Consent") is None
        finally:
            relay.close()

    def test_a_forged_ticket_does_not_keep_the_context(self, rt):
        view = self._preview(rt)
        rt.composer.prepare_send(view["previewId"], "x", consent=True)
        assert relay_headers.current() == ("whole-definition", True)
        relay_headers.on_prompt_submit({"_degram_send": True})
        assert relay_headers.current() is None
        rt.composer.prepare_send(view["previewId"], "x", consent=True)
        relay_headers.on_prompt_submit({"_degram_send": relay_headers.SEND_TICKET})
        assert relay_headers.current() == ("whole-definition", True)

    def test_without_a_context_the_headers_say_none(self, rt, agent_home):
        relay = FakeRelay()
        try:
            _arm_relay(relay)
            self._turn(relay, "hello")
            (post,) = relay.chat_posts()
            assert _hdr(post["headers"], "X-DeGram-Context-Scope") == "none"
        finally:
            relay.close()


RELAY_OUTCOMES = [
    (403, "POLICY_DENY", {"reason": "whole-definition-not-allowed"}),
    (403, "POLICY_DENY", {"reason": "provider-export-not-allowed"}),
    (428, "CONSENT_REQUIRED", {}),
    (503, "RELAY_NOT_CONFIGURED", {}),
    (504, "PROVIDER_TIMEOUT", {}),
    (429, "PROVIDER_RATE_LIMITED", {"retryAfter": 7}),
    (503, "PROVIDER_UNAVAILABLE", {}),
    (502, "PROVIDER_ERROR", {"upstreamStatus": 500}),
]


class TestRelayOutcomes:
    @pytest.mark.parametrize("status,code,extra", RELAY_OUTCOMES)
    def test_a_relay_error_is_terminal_named_and_never_retried(self, rt, agent_home, status, code, extra):
        body = {"detail": {"error": f"relay says {code}", "hint": "do the thing", "code": code, **extra}}
        relay = FakeRelay(status=status, error_body=body)
        try:
            _arm_relay(relay)
            started = time.monotonic()
            agent = server._make_agent("sid-out", "key-out")
            result = agent.run_conversation("hi")
            text = str(result.get("error"))
            assert code in text, text
            for value in extra.values():
                assert str(value) in text, text
            assert len(relay.chat_posts()) == 1, "exactly one request: no retry, no fallback"
            assert time.monotonic() - started < 10
        finally:
            relay.close()

    def test_consent_cannot_turn_a_policy_deny_into_a_send(self, rt, agent_home):
        body = {"detail": {"error": "DG policy does not allow sending this data to the model.", "hint": "ask the owner",
                           "code": "POLICY_DENY", "reason": "whole-definition-not-allowed"}}
        relay = FakeRelay(status=403, error_body=body)
        try:
            rt.documents.pin(**GH_PIN)
            view = rt.composer.preview("whole-definition")
            _arm_relay(relay)
            plan = rt.composer.prepare_send(view["previewId"], "go", consent=True)
            agent = server._make_agent("sid-deny", "key-deny")
            result = agent.run_conversation(plan.message)
            assert "POLICY_DENY" in str(result.get("error")) and "whole-definition-not-allowed" in str(result.get("error"))
            assert str(result.get("final_response")).startswith("POLICY_DENY:"), result.get("final_response")
            (post,) = relay.chat_posts()
            assert _hdr(post["headers"], "X-DeGram-Whole-Definition-Consent") == "true"
            # a second attempt with the same consent is denied again, and again exactly once
            agent.run_conversation(plan.message)
            assert len(relay.chat_posts()) == 2
        finally:
            relay.close()

    def test_an_unrelated_error_is_not_a_relay_outcome(self):
        from degram_variant.provider import relay_outcome
        assert relay_outcome(RuntimeError("boom")) is None
