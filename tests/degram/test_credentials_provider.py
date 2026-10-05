"""Variant degram: in-memory delegated credential + the pinned relay provider (plan 1301-10, D-06/D-16).

One streamed turn runs against a LOCAL fake OpenAI-compatible SSE relay (no real provider, no
network beyond loopback). The tests pin: the wire (path, Bearer token, alias model, stream), the
token's confinement to memory (log and file scans), renewal/clear/expiry behaviour and that the
runtime ignores every per-session/provider override.
"""

import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

import tui_gateway.server as server
from degram_variant.credentials import (
    CREDENTIALS_EXPIRED,
    CREDENTIALS_INVALID,
    CREDENTIALS_MISSING,
    DegramCredentials,
    DegramCredentialsError,
    credentials,
)
from degram_variant.lockdown import is_degram
from degram_variant.provider import DEGRAM_MODEL_ALIAS, pinned_model_and_runtime, pinned_runtime

TOKEN = "dgd_test_token_5f3a9c"


def _chunk(delta, finish=None, usage=None):
    body = {"id": "c1", "object": "chat.completion.chunk", "created": 1, "model": "m",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    if usage:
        body["usage"] = usage
    return f"data: {json.dumps(body)}\n\n".encode()


class FakeRelay:
    """Records every request; answers SSE (or a fixed error status when ``status`` != 200)."""

    def __init__(self, status: int = 200):
        self.requests: list[dict] = []
        self.status = status
        relay = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_a):
                pass

            def do_GET(self):
                relay.requests.append({"method": "GET", "path": self.path, "headers": dict(self.headers)})
                self.send_response(404)
                self.end_headers()

            def do_POST(self):
                n = int(self.headers.get("content-length", 0))
                body = json.loads(self.rfile.read(n) or b"{}")
                relay.requests.append({"method": "POST", "path": self.path, "headers": dict(self.headers), "body": body})
                if relay.status != 200:
                    payload = json.dumps({"error": {"message": "relay says no", "code": "denied"}}).encode()
                    self.send_response(relay.status)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                if not body.get("stream"):
                    payload = json.dumps({"id": "c1", "object": "chat.completion", "created": 1, "model": "m",
                                          "choices": [{"index": 0, "finish_reason": "stop",
                                                       "message": {"role": "assistant", "content": "ok"}}],
                                          "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode()
                    self.send_response(200)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()
                self.wfile.write(_chunk({"role": "assistant", "content": "hello"}))
                self.wfile.write(_chunk({"content": " from relay"}))
                self.wfile.write(_chunk({}, "stop", {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}))
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}/data-service"

    def chat_posts(self):
        return [r for r in self.requests if r["method"] == "POST" and r["path"].endswith("/chat/completions")]

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def degram(monkeypatch):
    monkeypatch.setenv("HERMES_DEGRAM", "1")
    # Plan 10 task 2 pins auxiliaries in code; here the model-written title upgrade is switched off the
    # ordinary way so a background title request cannot race the request counts below.
    from hermes_constants import get_hermes_home
    config_lines = ["auxiliary:", "  title_generation:", "    model_upgrade_enabled: false", ""]
    (Path(get_hermes_home()) / "config.yaml").write_text("\n".join(config_lines), encoding="utf-8")
    credentials.clear()
    yield
    credentials.clear()


@pytest.fixture
def relay():
    r = FakeRelay()
    yield r
    r.close()


def set_credentials(relay_base, token=TOKEN, expires_in=600, **extra):
    return credentials.set(
        token=token, expires_at=time.time() + expires_in, relay_base_url=relay_base,
        user="alice", company="acme", project="tower", **extra)


def rpc(method, params=None, rid=1):
    return server.handle_request({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})


def run_turn(text="hi"):
    agent = server._make_agent("sid-1", "key-1")
    return agent, agent.run_conversation(text)


# ── mode switch ──────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("value,expected", [("1", True), ("", False), ("0", False), ("true", False), ("yes", False)])
def test_is_degram_only_for_exactly_one(monkeypatch, value, expected):
    monkeypatch.setenv("HERMES_DEGRAM", value)
    assert is_degram() is expected


def test_is_degram_false_when_unset(monkeypatch):
    monkeypatch.delenv("HERMES_DEGRAM", raising=False)
    assert is_degram() is False


# ── credential store ─────────────────────────────────────────────────────────────────────────


class TestCredentialStore:
    def test_set_then_provider_returns_current_token(self):
        store = DegramCredentials()
        store.set(token=TOKEN, expires_at=time.time() + 60, relay_base_url="https://dg.example/data-service",
                  user="u", company=None, project="p")
        assert store.api_key_provider() == TOKEN
        info = store.info()
        assert info.relay_base_url == "https://dg.example/data-service" and info.company is None

    def test_missing_before_set_and_after_clear(self):
        store = DegramCredentials()
        with pytest.raises(DegramCredentialsError) as exc:
            store.api_key_provider()
        assert exc.value.code == CREDENTIALS_MISSING
        store.set(token=TOKEN, expires_at=time.time() + 60, relay_base_url="https://dg.example", user="u", project="p")
        store.clear()
        with pytest.raises(DegramCredentialsError) as exc:
            store.api_key_provider()
        assert exc.value.code == CREDENTIALS_MISSING and store.info() is None

    def test_expired_before_any_request(self):
        now = [1_000.0]
        store = DegramCredentials(clock=lambda: now[0])
        store.set(token=TOKEN, expires_at=1_100.0, relay_base_url="https://dg.example", user="u", project="p")
        assert store.api_key_provider() == TOKEN
        now[0] = 1_100.0  # inclusive boundary, as the server's token store
        with pytest.raises(DegramCredentialsError) as exc:
            store.api_key_provider()
        assert exc.value.code == CREDENTIALS_EXPIRED

    def test_expires_at_accepts_iso_and_epoch(self):
        store = DegramCredentials()
        info = store.set(token=TOKEN, expires_at="2099-01-01T00:00:00Z", relay_base_url="https://dg.example",
                         user="u", project="p")
        assert info.expires_at == 4070908800.0
        info = store.set(token=TOKEN, expires_at=4070908801, relay_base_url="https://dg.example", user="u", project="p")
        assert info.expires_at == 4070908801.0

    @pytest.mark.parametrize("kwargs", [
        {"token": ""}, {"token": 5}, {"user": ""}, {"project": " "}, {"expires_at": "tomorrow"}, {"expires_at": None},
        {"expires_at": True}, {"relay_base_url": ""}, {"relay_base_url": "ftp://dg.example"},
        {"relay_base_url": "http://dg.example.com/data-service"},  # cleartext off loopback
        {"relay_base_url": "https://user:pw@dg.example"}, {"relay_base_url": "https://dg.example/?x=1"},
        {"relay_base_url": "https://dg.example/#f"}, {"company": 7},
    ])
    def test_invalid_input_is_a_named_error_and_stores_nothing(self, kwargs):
        store = DegramCredentials()
        args = dict(token=TOKEN, expires_at=time.time() + 60, relay_base_url="https://dg.example", user="u", project="p")
        args.update(kwargs)
        with pytest.raises(DegramCredentialsError) as exc:
            store.set(**args)
        assert exc.value.code == CREDENTIALS_INVALID
        assert store.info() is None

    def test_http_is_allowed_for_loopback_only(self):
        store = DegramCredentials()
        for host in ("localhost", "127.0.0.1"):
            store.set(token=TOKEN, expires_at=time.time() + 60, relay_base_url=f"http://{host}:8080/data-service/",
                      user="u", project="p")
            assert store.info().relay_base_url == f"http://{host}:8080/data-service"

    def test_repr_str_and_pickle_never_carry_the_token(self):
        import copy
        import pickle
        store = DegramCredentials()
        store.set(token=TOKEN, expires_at=time.time() + 60, relay_base_url="https://dg.example", user="u", project="p")
        assert TOKEN not in repr(store) and TOKEN not in str(store) and TOKEN not in f"{store.info()}"
        for dump in (pickle.dumps, copy.deepcopy):
            with pytest.raises(TypeError):
                dump(store)


# ── RPC surface ──────────────────────────────────────────────────────────────────────────────


class TestCredentialRpc:
    PARAMS = {"token": TOKEN, "expiresAt": "2099-01-01T00:00:00Z", "relayBaseUrl": "http://127.0.0.1:8080/data-service",
              "user": "alice", "company": "acme", "project": "tower"}

    def test_set_is_refused_outside_degram(self, monkeypatch):
        monkeypatch.delenv("HERMES_DEGRAM", raising=False)
        credentials.clear()
        resp = rpc("degram.credentials.set", self.PARAMS)
        assert resp["error"]["data"]["code"] == "NOT_DEGRAM"
        assert credentials.info() is None
        assert TOKEN not in json.dumps(resp)

    def test_set_status_clear_never_echo_the_token(self, degram):
        ok = rpc("degram.credentials.set", self.PARAMS)
        assert ok["result"]["ok"] is True
        status = rpc("degram.credentials.status")
        assert status["result"]["present"] is True and status["result"]["project"] == "tower"
        assert status["result"]["relayBaseUrl"] == "http://127.0.0.1:8080/data-service"
        assert TOKEN not in json.dumps(ok) and TOKEN not in json.dumps(status)
        assert credentials.api_key_provider() == TOKEN
        cleared = rpc("degram.credentials.clear")
        assert cleared["result"] == {"ok": True}
        assert rpc("degram.credentials.status")["result"]["present"] is False
        with pytest.raises(DegramCredentialsError):
            credentials.api_key_provider()

    def test_invalid_params_answer_a_named_code(self, degram):
        resp = rpc("degram.credentials.set", {**self.PARAMS, "relayBaseUrl": "http://evil.example.com"})
        assert resp["error"]["data"]["code"] == CREDENTIALS_INVALID
        assert credentials.info() is None

    def test_unknown_param_key_is_rejected_by_the_contract(self, degram):
        resp = rpc("degram.credentials.set", {**self.PARAMS, "provider": "openrouter"})
        assert resp["error"]["code"] == 4000
        assert credentials.info() is None


# ── pinned runtime ───────────────────────────────────────────────────────────────────────────


class TestPinnedRuntime:
    def test_shape(self, degram):
        set_credentials("http://127.0.0.1:8080/data-service")
        model, runtime = pinned_model_and_runtime()
        assert model == DEGRAM_MODEL_ALIAS == "degram-system"
        assert runtime["provider"] == "custom" and runtime["api_mode"] == "chat_completions"
        assert runtime["base_url"] == "http://127.0.0.1:8080/data-service/degram/v1"
        assert runtime["credential_pool"] is None
        assert callable(runtime["api_key"]) and runtime["api_key"]() == TOKEN
        assert TOKEN not in repr({k: v for k, v in runtime.items() if k != "api_key"})

    def test_requires_a_scope_credential(self, degram):
        with pytest.raises(DegramCredentialsError) as exc:
            pinned_runtime()
        assert exc.value.code == CREDENTIALS_MISSING

    def test_gateway_ignores_every_session_and_provider_override(self, degram):
        set_credentials("http://127.0.0.1:8080/data-service")
        model, runtime = server._resolve_agent_model_runtime(
            {"model": "gpt-9", "provider": "openrouter", "base_url": "http://evil.example/v1", "api_key": "sk-evil"},
            "anthropic")
        assert model == DEGRAM_MODEL_ALIAS
        assert runtime["base_url"].endswith("/data-service/degram/v1") and runtime["provider"] == "custom"
        assert runtime["api_key"] is not None and runtime["api_key"] != "sk-evil"

    def test_fallback_chain_is_empty_even_when_configured(self, degram, monkeypatch):
        monkeypatch.setattr(server, "_load_cfg", lambda: {
            "fallback_providers": [{"provider": "openrouter", "model": "x/y"}],
            "fallback_model": {"provider": "anthropic", "model": "claude"}})
        assert server._load_fallback_model() == []

    def test_non_degram_resolution_is_untouched(self, monkeypatch):
        monkeypatch.delenv("HERMES_DEGRAM", raising=False)
        import inspect
        src = inspect.getsource(server._resolve_agent_model_runtime)
        assert "is_degram()" in src and "pinned_model_and_runtime" in src  # guarded, not unconditional


# ── one streamed turn ────────────────────────────────────────────────────────────────────────


def _home_files(home: Path):
    for root, _dirs, files in os.walk(home):
        for name in files:
            yield Path(root) / name


def _home_contains(home: Path, needle: str) -> list[str]:
    hits = []
    for path in _home_files(home):
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if needle.encode() in data:
            hits.append(str(path))
    return hits


class TestStreamedTurn:
    def test_turn_talks_only_to_the_relay_with_the_delegated_token(self, degram, relay):
        set_credentials(relay.base)
        agent, result = run_turn()
        assert result["final_response"] == "hello from relay"
        assert agent.provider == "custom" and agent.model == DEGRAM_MODEL_ALIAS and agent.api_mode == "chat_completions"
        # every byte the agent sent went to the one relay endpoint: no capability probes (/api/show, /models)
        assert relay.requests, "the agent never called the relay"
        assert {(r["method"], r["path"]) for r in relay.requests} == {("POST", "/data-service/degram/v1/chat/completions")}
        first = relay.chat_posts()[0]
        assert first["headers"]["Authorization"] == f"Bearer {TOKEN}"
        assert first["body"]["model"] == DEGRAM_MODEL_ALIAS and first["body"]["stream"] is True

    def test_the_agent_holds_a_callable_not_the_token(self, degram, relay):
        set_credentials(relay.base)
        agent = server._make_agent("sid-2", "key-2")
        held = agent._client_kwargs["api_key"]
        assert callable(held) and held() == TOKEN
        assert getattr(agent, "api_key", "") != TOKEN
        assert TOKEN not in repr(vars(agent).get("_client_kwargs"))

    def test_renewal_is_used_by_the_next_request(self, degram, relay):
        set_credentials(relay.base, token="dgd_first")
        agent = server._make_agent("sid-3", "key-3")
        agent.run_conversation("one")
        set_credentials(relay.base, token="dgd_second")
        agent.run_conversation("two")
        tokens = [r["headers"]["Authorization"] for r in relay.chat_posts()]
        assert tokens[0] == "Bearer dgd_first" and "Bearer dgd_second" in tokens[1:]

    def test_clear_makes_the_next_call_fail_named_and_fast(self, degram, relay):
        set_credentials(relay.base)
        agent = server._make_agent("sid-4", "key-4")
        agent.run_conversation("one")
        sent = len(relay.requests)
        credentials.clear()
        started = time.monotonic()
        result = agent.run_conversation("two")
        assert CREDENTIALS_MISSING in str(result.get("error"))
        assert time.monotonic() - started < 5, "a credential failure must not walk the retry/backoff ladder"
        assert len(relay.requests) == sent, "no request may leave once the credential is cleared"

    def test_expired_credential_fails_before_any_request(self, degram, relay):
        set_credentials(relay.base, expires_in=600)
        agent = server._make_agent("sid-5", "key-5")
        credentials.set(token=TOKEN, expires_at=time.time() - 1, relay_base_url=relay.base, user="alice",
                        company="acme", project="tower")
        result = agent.run_conversation("hi")
        assert CREDENTIALS_EXPIRED in str(result.get("error"))
        assert relay.requests == []

    def test_agent_cannot_be_built_without_a_credential(self, degram):
        with pytest.raises(DegramCredentialsError) as exc:
            server._make_agent("sid-6", "key-6")
        assert exc.value.code == CREDENTIALS_MISSING


class TestTokenNeverLeaks:
    def _assert_clean(self, caplog, home):
        assert TOKEN not in caplog.text
        for record in caplog.records:
            assert TOKEN not in record.getMessage()
        assert _home_contains(home, TOKEN) == [], "the delegated token reached a file under the DeGram home"

    def test_successful_turn(self, degram, relay, caplog):
        caplog.set_level(logging.DEBUG)
        set_credentials(relay.base)
        run_turn()
        from hermes_constants import get_hermes_home
        self._assert_clean(caplog, Path(get_hermes_home()))

    def test_provider_error_turn_writes_no_token_to_dumps_or_logs(self, degram, caplog):
        failing = FakeRelay(status=401)
        try:
            caplog.set_level(logging.DEBUG)
            set_credentials(failing.base)
            agent = server._make_agent("sid-7", "key-7")
            result = agent.run_conversation("hi")
            assert result.get("error") or result.get("failed")
            assert failing.chat_posts(), "the failing request must have reached the relay"
            from hermes_constants import get_hermes_home
            self._assert_clean(caplog, Path(get_hermes_home()))
        finally:
            failing.close()

    def test_rpc_set_does_not_log_or_persist_the_token(self, degram, caplog):
        caplog.set_level(logging.DEBUG)
        rpc("degram.credentials.set", {"token": TOKEN, "expiresAt": "2099-01-01T00:00:00Z",
                                       "relayBaseUrl": "http://127.0.0.1:1/data-service", "user": "a", "project": "p"})
        from hermes_constants import get_hermes_home
        self._assert_clean(caplog, Path(get_hermes_home()))
        assert TOKEN not in json.dumps({k: v for k, v in os.environ.items()})
