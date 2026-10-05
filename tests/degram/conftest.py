"""Shared fixtures for the DeGram read-capability tests (plan 1301-11)."""

from __future__ import annotations

import time

import pytest

from degram_variant.credentials import credentials

from .fakes import GH_DOC_ID, FakeDg, FakeGh, gh_context, gh_identity, gh_node

TOKEN = "dgd_read_token_77aa"
PROJECT = "tower"
RULES = {"project": PROJECT, "rules": [
    {"ruleId": "R_URB_HEIGHT_MAX_75_V", "text": "Maximum building height is 75 meters"},
    {"ruleId": "R_URB_FAR_MAX_3_V", "text": "Floor area ratio must not exceed 3"}]}
GRAPH = {"nodes": [{"id": "n1", "labels": ["Rule"], "props": {"Rule_Id": "R_URB_HEIGHT_MAX_75_V"}}], "rels": []}


def default_gh_handlers(nodes=None, selection=None, identity=None):
    nodes = nodes if nodes is not None else [gh_node(i) for i in range(1, 6)]
    selected = selection if selection is not None else [n["instanceId"] for n in nodes[:2]]
    ident = identity or gh_identity()
    return {"get_document_identity": ident, "get_selection": {"selection": selected},
            "get_canvas_context": gh_context(nodes, ident["documentId"]), "get_preview_status": {"pending": 0}}


@pytest.fixture
def gh():
    fake = FakeGh(default_gh_handlers())
    yield fake
    fake.close()


@pytest.fixture
def dg():
    fake = FakeDg({f"/data-service/rules/{PROJECT}": (200, RULES), f"/data-service/graph/{PROJECT}": (200, GRAPH)})
    yield fake
    fake.close()


@pytest.fixture
def rt(monkeypatch, gh, dg):
    """A fresh DeGram runtime wired to the fake GH bridge and fake DG backend, scope alice/acme/tower."""
    from degram_variant import gh_bridge, runtime

    monkeypatch.setenv("HERMES_DEGRAM", "1")
    monkeypatch.setattr(gh_bridge, "GH_PORT", gh.port)
    credentials.clear()
    credentials.set(token=TOKEN, expires_at=time.time() + 600, relay_base_url=dg.base, user="alice", company="acme",
                    project=PROJECT)
    runtime.reset()
    yield runtime.get()
    runtime.reset()
    credentials.clear()


GH_PIN = {"app": "grasshopper", "identity": {"documentId": GH_DOC_ID, "filePath": "C:/work/tower.gh"}}
