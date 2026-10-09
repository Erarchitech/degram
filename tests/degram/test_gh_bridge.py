"""GH bridge client and GH documents (plan 1301-11 task 1; D-13, D-15, T-1301-11-01/-02/-06).

Everything runs against a fake newline-JSON listener on loopback. No Rhino, no Grasshopper."""

from __future__ import annotations

import inspect
from pathlib import Path

import pytest

from degram_variant import gh_bridge
from degram_variant.gh_bridge import GH_READ_COMMANDS, GhBridgeClient
from degram_variant.outcomes import BridgeError

from .conftest import GH_PIN
from .fakes import FakeGh, Raw, gh_error, gh_identity, free_port


class TestReadOnlyClient:
    def test_read_commands_are_exactly_the_four_reads(self):
        assert GH_READ_COMMANDS == frozenset(
            {"get_canvas_context", "get_selection", "get_preview_status", "get_document_identity"})

    @pytest.mark.parametrize("command", ["preview_structure", "clear_preview", "add_component", "connect_components",
                                         "", "GET_SELECTION", "get_selection ", "set_parameter"])
    def test_any_other_command_raises_before_connecting(self, gh, command):
        client = GhBridgeClient(port=gh.port)
        with pytest.raises(BridgeError) as exc:
            client.call(command, {})
        assert exc.value.code == "DEGRAM_LOCKED"
        assert gh.connections == 0, "a refused command must not even open a connection"

    def test_host_is_the_loopback_constant_with_no_knob(self, monkeypatch):
        assert gh_bridge.GH_HOST == "127.0.0.1"
        assert "host" not in inspect.signature(GhBridgeClient.__init__).parameters
        monkeypatch.setenv("GH_BRIDGE_HOST", "evil.example")
        assert gh_bridge.GH_HOST == "127.0.0.1"
        assert GhBridgeClient()._address()[0] == "127.0.0.1"

    def test_result_payload_is_returned(self, gh):
        assert GhBridgeClient(port=gh.port).call("get_selection")["selection"]
        assert gh.commands() == ["get_selection"]

    def test_listener_down_is_bridge_off(self):
        with pytest.raises(BridgeError) as exc:
            GhBridgeClient(port=free_port()).call("get_document_identity")
        assert exc.value.code == "BRIDGE_OFF"

    def test_busy_envelope_is_busy(self):
        fake = FakeGh({"get_document_identity": gh_error("BUSY", "UI thread busy")})
        try:
            with pytest.raises(BridgeError) as exc:
                GhBridgeClient(port=fake.port).call("get_document_identity")
            assert exc.value.code == "BUSY"
        finally:
            fake.close()

    def test_unknown_command_means_the_extension_is_old_or_missing(self):
        fake = FakeGh({})
        try:
            with pytest.raises(BridgeError) as exc:
                GhBridgeClient(port=fake.port).call("get_document_identity")
            assert exc.value.code == "EXTENSION_NOT_LOADED"
        finally:
            fake.close()

    def test_no_active_document_is_document_not_open(self):
        fake = FakeGh({"get_document_identity": gh_error("HANDLER_ERROR", "No active document.")})
        try:
            with pytest.raises(BridgeError) as exc:
                GhBridgeClient(port=fake.port).call("get_document_identity")
            assert exc.value.code == "DOCUMENT_NOT_OPEN"
        finally:
            fake.close()

    def test_a_listener_that_is_not_the_dg_bridge_is_setup_incomplete(self):
        fake = FakeGh({"get_selection": Raw({"status": "ok", "result": {}})})  # no "bridge": "dg"
        try:
            with pytest.raises(BridgeError) as exc:
                GhBridgeClient(port=fake.port).call("get_selection")
            assert exc.value.code == "SETUP_INCOMPLETE"
        finally:
            fake.close()

    def test_oversized_response_is_refused_by_a_byte_count(self, monkeypatch):
        monkeypatch.setattr(gh_bridge, "MAX_RESPONSE_BYTES", 2048)
        fake = FakeGh({"get_selection": {"selection": ["x" * 100] * 100}})
        try:
            with pytest.raises(BridgeError) as exc:
                GhBridgeClient(port=fake.port).call("get_selection")
            assert exc.value.code == "SETUP_INCOMPLETE" and exc.value.reason == "RESPONSE_TOO_LARGE"
        finally:
            fake.close()


class TestGhDocuments:
    def test_list_returns_one_gh_row_with_identity(self, rt):
        listing = rt.documents.list()
        group = next(g for g in listing["groups"] if g["app"] == "grasshopper")
        assert group["state"] == "ready"
        (row,) = group["documents"]
        assert row["name"] == "tower.gh" and row["path"] == "C:/work/tower.gh" and row["unsaved"] is False
        assert row["identity"] == {"documentId": gh_identity()["documentId"], "filePath": "C:/work/tower.gh"}
        assert listing["pinned"] == {}, "nothing is pinned until pin is called, even with a single document"

    def test_unsaved_document_is_marked(self, rt, gh):
        gh.handlers["get_document_identity"] = gh_identity(file_path=None, name="Untitled")
        row = next(g for g in rt.documents.list()["groups"] if g["app"] == "grasshopper")["documents"][0]
        assert row["unsaved"] is True and row["path"] is None and row["identity"]["filePath"] is None

    def test_listener_down_marks_the_group_bridge_off(self, rt, monkeypatch):
        monkeypatch.setattr(gh_bridge, "GH_PORT", free_port())
        group = next(g for g in rt.documents.list()["groups"] if g["app"] == "grasshopper")
        assert group["state"] == "off" and group["code"] == "BRIDGE_OFF" and group["documents"] == []

    def test_busy_marks_the_group_busy(self, rt, gh):
        gh.handlers["get_document_identity"] = gh_error("BUSY")
        group = next(g for g in rt.documents.list()["groups"] if g["app"] == "grasshopper")
        assert group["state"] == "busy" and group["code"] == "BUSY"

    def test_pin_verifies_the_document_is_open_and_records_it(self, rt):
        pinned = rt.documents.pin(**GH_PIN)
        assert pinned["app"] == "grasshopper" and pinned["identity"]["documentId"] == GH_PIN["identity"]["documentId"]
        assert rt.documents.pinned == {"grasshopper": pinned}

    def test_pin_of_a_document_that_is_not_open_is_refused(self, rt):
        with pytest.raises(BridgeError) as exc:
            rt.documents.pin("grasshopper", {"documentId": "ffffffff-0000-0000-0000-000000000000", "filePath": None})
        assert exc.value.code in {"DOCUMENT_NOT_OPEN", "IDENTITY_MISMATCH"}
        assert rt.documents.pinned == {}

    def test_pin_with_an_unknown_app_is_refused(self, rt):
        with pytest.raises(ValueError):
            rt.documents.pin("autocad", {"x": 1})

    def test_unpin_clears_and_bumps_the_generation(self, rt):
        rt.documents.pin(**GH_PIN)
        before = rt.documents.generation
        rt.documents.unpin("grasshopper")
        assert rt.documents.pinned == {} and rt.documents.generation > before
        rt.documents.pin(**GH_PIN)
        before = rt.documents.generation
        rt.documents.unpin_all()
        assert rt.documents.pinned == {} and rt.documents.generation > before

    def test_unpin_with_an_unknown_app_is_refused(self, rt):
        with pytest.raises(ValueError):
            rt.documents.unpin("autocad")


class TestVocabulary:
    """Every code this component emits is in the framework's closed operational vocabulary."""

    SPEC = Path(__file__).resolve().parents[4] / "spec" / "degram" / "OPERATIONAL-OUTCOMES.md"

    def test_emitted_codes_are_in_the_closed_set(self):
        from degram_variant.outcomes import EMITTED_CODES

        if not self.SPEC.is_file():
            pytest.skip("framework spec not present (component checked out on its own)")
        text = self.SPEC.read_text(encoding="utf-8")
        block = text.split("degram-outcomes:codes:start -->", 1)[1].split("<!-- degram-outcomes:codes:end", 1)[0]
        closed = {line.strip() for line in block.splitlines() if line.strip() and not line.startswith("```")}
        assert EMITTED_CODES <= closed, sorted(EMITTED_CODES - closed)


class TestPreviewBudget:
    """1301-19, G-14: the preview snapshot shares ONE read budget across its three bridge calls."""

    class _Client:
        def __init__(self, clock, spend):
            self.clock, self.spend, self.timeouts = clock, spend, []

        def call(self, command, parameters=None, *, cancel=None, read_timeout_s=None):
            self.timeouts.append((command, read_timeout_s))
            self.clock["now"] += self.spend
            if command == "get_document_identity":
                return gh_identity()
            if command == "get_selection":
                return {"selection": ["a"]}
            return {"definition": {"documentId": gh_identity()["documentId"]}, "nodes": []}

    def _source(self, monkeypatch, spend):
        clock = {"now": 1000.0}
        monkeypatch.setattr(gh_bridge, "_monotonic", lambda: clock["now"])
        client = self._Client(clock, spend)
        return gh_bridge.GhDocumentSource(client=client), client

    def test_each_call_gets_what_the_earlier_calls_left(self, monkeypatch):
        source, client = self._source(monkeypatch, spend=6.0)
        source.read_snapshot(GH_PIN, "selection", "tower", deadline_s=20.0)
        assert [t for _, t in client.timeouts] == [20.0, 14.0, 8.0]

    def test_an_exhausted_budget_is_busy_before_the_next_call(self, monkeypatch):
        source, client = self._source(monkeypatch, spend=11.0)
        with pytest.raises(BridgeError) as exc:
            source.read_snapshot(GH_PIN, "selection", "tower", deadline_s=20.0)
        assert exc.value.code == "BUSY"
        assert [c for c, _ in client.timeouts] == ["get_document_identity", "get_selection"], "no third call"

    def test_without_a_deadline_the_tool_read_timeout_is_kept(self, monkeypatch):
        source, client = self._source(monkeypatch, spend=6.0)
        source.read_snapshot(GH_PIN, "selection", "tower")
        assert [t for _, t in client.timeouts] == [None, None, None]
