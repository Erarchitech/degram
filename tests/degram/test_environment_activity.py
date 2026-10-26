"""Fail-closed backend activity fence for DGMODE target switches.

These tests exercise the gateway handler directly: an environment may quiesce only when no
real session is running, and a successful barrier rejects new work for its generation until
main either resumes it after a pre-persistence abort or replaces the runtime.
"""

from __future__ import annotations

import threading

import tui_gateway.server as server


ENVIRONMENT = "dg-env-v1-" + "a" * 64


def rpc(method: str, params: dict | None = None, rid: int = 1) -> dict:
    return server.handle_request({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})


def setup_function() -> None:
    with server._sessions_lock:
        server._sessions.clear()
    with server._degram_environment_lock:
        assert server._degram_environment_work == 0
        server._degram_environment_barrier = None


def teardown_function() -> None:
    with server._degram_environment_lock:
        assert server._degram_environment_work == 0
        server._degram_environment_barrier = None


def test_quiesce_refuses_while_a_real_session_is_running(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_DEGRAM", "1")
    with server._sessions_lock:
        server._sessions["s1"] = {"running": True}

    result = rpc("degram.environment.quiesce", {"environmentId": ENVIRONMENT, "generation": 3})

    assert result["error"]["data"]["code"] == "ENVIRONMENT_BUSY"
    assert server._degram_environment_barrier is None


def test_quiesce_blocks_new_generation_work_until_explicit_resume(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_DEGRAM", "1")

    assert rpc("degram.environment.quiesce", {"environmentId": ENVIRONMENT, "generation": 3})["result"] == {"ok": True}
    refused = rpc("degram.environment.assert_active", {"environmentId": ENVIRONMENT, "generation": 3})
    assert refused["error"]["data"]["code"] == "ENVIRONMENT_QUIESCED"

    assert rpc("degram.environment.resume", {"environmentId": ENVIRONMENT, "generation": 3})["result"] == {"ok": True}
    assert rpc("degram.environment.assert_active", {"environmentId": ENVIRONMENT, "generation": 3})["result"] == {"ok": True}


def test_resume_cannot_unblock_a_different_generation(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_DEGRAM", "1")
    assert rpc("degram.environment.quiesce", {"environmentId": ENVIRONMENT, "generation": 3})["result"] == {"ok": True}

    refused = rpc("degram.environment.resume", {"environmentId": ENVIRONMENT, "generation": 4})

    assert refused["error"]["data"]["code"] == "ENVIRONMENT_GENERATION_MISMATCH"
    assert server._degram_environment_barrier == {"environmentId": ENVIRONMENT, "generation": 3}


def test_quiesce_fails_closed_when_the_session_snapshot_cannot_be_read(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_DEGRAM", "1")

    class BrokenLock:
        def __enter__(self):
            raise RuntimeError("lock unavailable")

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr(server, "_sessions_lock", BrokenLock())

    result = rpc("degram.environment.quiesce", {"environmentId": ENVIRONMENT, "generation": 3})

    assert result["error"]["data"]["code"] == "ENVIRONMENT_ACTIVITY_UNKNOWN"
    assert server._degram_environment_barrier is None


def test_frozen_backend_rejects_untagged_and_other_generation_work(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_DEGRAM", "1")
    assert rpc("degram.environment.quiesce", {"environmentId": ENVIRONMENT, "generation": 3})["result"]["ok"]
    for params in ({}, {"_degram_environment": {"environmentId": ENVIRONMENT, "generation": 4}}):
        response = rpc("degram.documents.list", params)
        assert response["error"]["data"]["code"] == "ENVIRONMENT_QUIESCED"
    assert rpc("degram.credentials.status")["result"]["present"] is False
    mismatch = rpc("degram.environment.quiesce", {"environmentId": ENVIRONMENT, "generation": 4})
    assert mismatch["error"]["data"]["code"] == "ENVIRONMENT_GENERATION_MISMATCH"


def test_running_handler_reserves_work_until_actual_completion(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_DEGRAM", "1")
    entered, finish = threading.Event(), threading.Event()
    responses = []

    def handler(rid, _params):
        entered.set()
        assert finish.wait(5)
        return server._ok(rid, {"status": "ok"})

    monkeypatch.setitem(server._methods, "degram.documents.list", handler)
    thread = threading.Thread(target=lambda: responses.append(rpc("degram.documents.list")))
    thread.start()
    try:
        assert entered.wait(5)
        refused = rpc("degram.environment.quiesce", {"environmentId": ENVIRONMENT, "generation": 3})
        assert refused["error"]["data"]["code"] == "ENVIRONMENT_BUSY"
    finally:
        finish.set()
        thread.join(5)
    assert not thread.is_alive()
    assert responses and "result" in responses[0]
    assert rpc("degram.environment.quiesce", {"environmentId": ENVIRONMENT, "generation": 3})["result"]["ok"]


def test_quiesce_and_new_admission_cannot_cross_the_idle_snapshot(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_DEGRAM", "1")
    probing, finish_probe, attempted = threading.Event(), threading.Event(), threading.Event()
    responses, work = [], []

    def probe():
        probing.set()
        assert finish_probe.wait(5)
        return False

    def request():
        attempted.set()
        work.append(rpc("degram.documents.list"))

    monkeypatch.setattr(server, "_degram_has_active_work", probe)
    switch = threading.Thread(target=lambda: responses.append(
        rpc("degram.environment.quiesce", {"environmentId": ENVIRONMENT, "generation": 3})))
    incoming = threading.Thread(target=request)
    switch.start()
    try:
        assert probing.wait(5)
        incoming.start()
        assert attempted.wait(5)
    finally:
        finish_probe.set()
        switch.join(5)
        if incoming.ident is not None:
            incoming.join(5)
    assert not switch.is_alive() and not incoming.is_alive()
    assert responses[0]["result"]["ok"]
    assert work[0]["error"]["data"]["code"] == "ENVIRONMENT_QUIESCED"


def test_queued_long_handler_reserves_before_enqueue_and_releases_on_cancel(monkeypatch) -> None:
    from concurrent.futures import Future

    monkeypatch.setenv("HERMES_DEGRAM", "1")
    pending = Future()

    class QueuedPool:
        def submit(self, _run):
            return pending

    monkeypatch.setattr(server, "_pool", QueuedPool())
    monkeypatch.setattr(server, "_LONG_HANDLERS", {"degram.documents.list"})
    try:
        assert server.dispatch({"id": 1, "method": "degram.documents.list", "params": {}}) is None
        assert server._degram_environment_work == 1
        refused = rpc("degram.environment.quiesce", {"environmentId": ENVIRONMENT, "generation": 3})
        assert refused["error"]["data"]["code"] == "ENVIRONMENT_BUSY"
    finally:
        pending.cancel()
    assert server._degram_environment_work == 0
    assert rpc("degram.environment.quiesce", {"environmentId": ENVIRONMENT, "generation": 3})["result"]["ok"]


def test_enqueue_failure_releases_environment_admission(monkeypatch) -> None:
    import pytest

    monkeypatch.setenv("HERMES_DEGRAM", "1")

    class FailedPool:
        def submit(self, _run):
            raise RuntimeError("pool closed")

    monkeypatch.setattr(server, "_pool", FailedPool())
    monkeypatch.setattr(server, "_LONG_HANDLERS", {"degram.documents.list"})
    with pytest.raises(RuntimeError, match="pool closed"):
        server.dispatch({"id": 1, "method": "degram.documents.list", "params": {}})
    assert server._degram_environment_work == 0


def test_main_stamp_is_validated_before_closed_method_contracts(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_DEGRAM", "1")
    stamp = {"environmentId": ENVIRONMENT, "generation": 3}
    response = rpc("degram.credentials.status", {"_degram_environment": stamp})
    assert response["result"]["present"] is False
    refused = rpc("degram.credentials.status", {"_degram_environment": {"environmentId": "bad", "generation": 3}})
    assert refused["error"]["data"]["code"] == "BAD_ENVIRONMENT"


def test_environment_rejection_never_elevates_the_loopback_native_surface(monkeypatch) -> None:
    monkeypatch.setenv("HERMES_DEGRAM", "1")
    assert rpc("degram.environment.quiesce", {"environmentId": ENVIRONMENT, "generation": 3})["result"]["ok"]

    denied = rpc("degram.documents.list", {"_degram_environment": {
        "environmentId": ENVIRONMENT, "generation": 4,
    }})

    assert denied["error"]["data"]["code"] == "ENVIRONMENT_QUIESCED"
    assert server._degram_environment_work == 0


def test_stock_hermes_does_not_participate_in_environment_admission(monkeypatch) -> None:
    monkeypatch.delenv("HERMES_DEGRAM", raising=False)
    server._degram_environment_barrier = {"environmentId": ENVIRONMENT, "generation": 3}
    monkeypatch.setitem(server._methods, "test.stock", lambda rid, _params: server._ok(rid, {"ok": True}))
    assert rpc("test.stock")["result"] == {"ok": True}
    assert server._degram_environment_work == 0
