"""Cooperative cancellation of in-flight CAD reads (1301 D-18, DGCL-06).

A :class:`CancelToken` is checked by the bridge clients between short waits (<= 50 ms), so a cancel closes the socket
or abandons the MCP call within a second. It also honours the per-thread interrupt of the agent
(``tools.interrupt``): ``session.interrupt`` interrupts the turn's tool threads, which is how a tool-driven read
(``degram_document_snapshot``) is cancelled. A token bound to a thread (``bind_current_thread``) additionally sets that
thread's interrupt bit so the Hermes MCP client (``_run_on_mcp_loop``) abandons its call; the bit is cleared again
on ``release`` and never set after it."""

from __future__ import annotations

import threading
from contextlib import contextmanager

from .outcomes import CANCELLED, BridgeError

POLL_INTERVAL_S = 0.05


def _interrupted() -> bool:
    try:
        from tools.interrupt import is_interrupted
    except Exception:  # pragma: no cover - outside the Hermes tree
        return False
    return is_interrupted()


class CancelToken:
    def __init__(self) -> None:
        self._event = threading.Event()
        self._lock = threading.Lock()
        self._tid: int | None = None
        self._flagged = False

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def wait(self, timeout: float) -> bool:
        """Sleep up to ``timeout`` seconds; True when cancelled meanwhile."""
        return self._event.wait(timeout)

    def bind_current_thread(self) -> None:
        with self._lock:
            self._tid = threading.get_ident()

    def cancel(self) -> None:
        with self._lock:
            self._event.set()
            tid = self._tid
            if tid is not None and not self._flagged:
                from tools.interrupt import set_interrupt
                set_interrupt(True, tid, reason="degram-cancel")
                self._flagged = True

    def release(self) -> None:
        """The read is over: drop the thread binding and clear an interrupt bit this token set."""
        with self._lock:
            tid, flagged = self._tid, self._flagged
            self._tid, self._flagged = None, False
        if flagged and tid is not None:
            from tools.interrupt import set_interrupt
            set_interrupt(False, tid)

    def check(self) -> None:
        """Raise ``CANCELLED`` when this token or the current thread's interrupt asks to stop."""
        if self._event.is_set() or _interrupted():
            raise BridgeError(CANCELLED, "CANCELLED_BY_USER", "The read was cancelled.")

    @contextmanager
    def active(self):
        self.bind_current_thread()
        try:
            yield self
        finally:
            self.release()


def check(token: CancelToken | None) -> None:
    """``token.check()`` that also honours the thread interrupt when there is no token."""
    if token is not None:
        token.check()
    elif _interrupted():
        raise BridgeError(CANCELLED, "CANCELLED_BY_USER", "The read was cancelled.")


class CancelRegistry:
    """Tokens of the in-flight reads, keyed by what the client can name (a previewId or a read id)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tokens: dict[str, list[CancelToken]] = {}

    def new(self, key: str) -> CancelToken:
        token = CancelToken()
        with self._lock:
            self._tokens.setdefault(key, []).append(token)
        return token

    def discard(self, key: str, token: CancelToken) -> None:
        with self._lock:
            tokens = self._tokens.get(key, [])
            if token in tokens:
                tokens.remove(token)
            if not tokens:
                self._tokens.pop(key, None)

    def cancel(self, key: str | None = None) -> int:
        """Cancel the reads of ``key`` (all in-flight reads when None). Returns how many were signalled."""
        with self._lock:
            if key is None:
                targets = [t for ts in self._tokens.values() for t in ts]
            else:
                targets = list(self._tokens.get(key, []))
        for token in targets:
            token.cancel()
        return len(targets)

    def in_flight(self) -> int:
        with self._lock:
            return sum(len(ts) for ts in self._tokens.values())
