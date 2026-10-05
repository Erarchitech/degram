"""The process-wide read-capability state of variant degram: bridges, pinned document, previews, in-flight reads.

One DeGram gateway process serves one user, company and project at a time (D-19), so one runtime is enough. Tests
build a fresh one with :func:`reset`; a scope change or sign-out clears it in place with :func:`reset_scope`."""

from __future__ import annotations

import threading

from . import relay_headers
from .cancel import CancelRegistry
from .context_composer import ContextComposer
from .dg_client import DgClient
from .documents import DocumentsService


class Runtime:
    def __init__(self) -> None:
        from .gh_bridge import GhDocumentSource

        sources = {"grasshopper": GhDocumentSource()}
        try:  # the Revit adapter is an MCP stdio child; its client is optional in a stripped component
            from .revit_bridge import RevitDocumentSource
            sources["revit"] = RevitDocumentSource()
        except ImportError:  # pragma: no cover - revit_bridge ships with the component
            pass
        self.cancels = CancelRegistry()
        self.documents = DocumentsService(sources)
        self.dg = DgClient()
        self.composer = ContextComposer(self.documents, self.dg, self.cancels)


_lock = threading.Lock()
_runtime: Runtime | None = None


def get() -> Runtime:
    global _runtime
    with _lock:
        if _runtime is None:
            _runtime = Runtime()
        return _runtime


def reset() -> None:
    """Drop the runtime (tests, process teardown). In-flight reads are cancelled first."""
    global _runtime
    with _lock:
        old, _runtime = _runtime, None
    if old is not None:
        old.cancels.cancel()
    relay_headers.clear()


def reset_scope() -> None:
    """Sign-out or scope change (D-08): cancel reads, forget the pinned document, previews and the relay context."""
    with _lock:
        current = _runtime
    if current is not None:
        current.cancels.cancel()
        current.documents.reset()
        current.composer.clear()
    relay_headers.clear()
