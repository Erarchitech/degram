"""Context composer: bounded payload, preview == sent bytes, document pinning (plan 1301-11 task 1; D-13..D-17).

Fake GH listener, fake DG backend and fake relay only; the e2e test drives a real agent turn against the relay."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

import tui_gateway.server as server
from degram_variant import gh_bridge
from degram_variant.context_composer import SNAPSHOT_LIMITS, ContextError
from degram_variant.credentials import credentials
from degram_variant.outcomes import BridgeError

from .conftest import GH_PIN, PROJECT, RULES, TOKEN, default_gh_handlers
from .fakes import FakeRelay, gh_identity, gh_node


def _json_part(payload: str):
    """The JSON document that follows the short text header of a payload."""
    return json.loads(payload[payload.index("\n{") + 1:])


def _hdr(headers: dict, name: str):
    return next((v for k, v in headers.items() if k.lower() == name.lower()), None)


class TestLimitsConstant:
    def test_limits_are_the_plan_values(self):
        assert SNAPSHOT_LIMITS["max_objects"] == 200
        assert SNAPSHOT_LIMITS["max_parameters"] == 50
        assert SNAPSHOT_LIMITS["max_bytes"] == 256 * 1024
        with pytest.raises(TypeError):
            SNAPSHOT_LIMITS["max_objects"] = 1  # read-only


class TestPreview:
    def test_selection_filters_the_canvas_context_and_counts(self, rt, gh):
        rt.documents.pin(**GH_PIN)
        view = rt.composer.preview("selection")
        assert view["status"] == "ok" and view["scope"] == "selection" and view["requiresConsent"] is False
        summary = view["summary"]
        assert summary["project"] == PROJECT and summary["objects"] == 2 and summary["parameters"] == 4
        assert summary["rules"] == 2 and summary["fragments"] == 0 and summary["emptySelection"] is False
        assert summary["bytes"] == len(view["payload"].encode("utf-8"))
        assert summary["document"]["name"] == "tower.gh" and summary["document"]["app"] == "grasshopper"
        body = _json_part(view["payload"])
        guids = [n["instanceId"] for n in body["snapshot"]["nodes"]]
        assert guids == [gh_node(1)["instanceId"], gh_node(2)["instanceId"]]
        assert gh_node(3)["instanceId"] not in view["payload"]
        assert view["truncation"] == [] and view["missing"] == []
        # the short header names project, document and scope
        head = view["payload"].split("\n{", 1)[0]
        assert PROJECT in head and "tower.gh" in head and "selection" in head

    def test_only_read_commands_reach_the_bridge_and_identity_comes_first(self, rt, gh):
        rt.documents.pin(**GH_PIN)
        gh.requests.clear()
        rt.composer.preview("selection")
        assert set(gh.commands()) <= gh_bridge.GH_READ_COMMANDS
        assert gh.commands()[0] == "get_document_identity"

    def test_rules_come_from_the_dg_backend_with_the_delegated_token_only(self, rt, dg):
        rt.documents.pin(**GH_PIN)
        view = rt.composer.preview("selection")
        assert dg.paths() == [f"/data-service/rules/{PROJECT}"], "no graph read, no other project, no other route"
        assert dg.requests[0]["headers"]["Authorization"] == f"Bearer {TOKEN}"
        body = _json_part(view["payload"])
        assert [r["ruleId"] for r in body["rules"]] == [r["ruleId"] for r in RULES["rules"]]

    def test_the_token_is_never_in_the_payload(self, rt):
        rt.documents.pin(**GH_PIN)
        assert TOKEN not in rt.composer.preview("selection")["payload"]

    def test_identity_change_is_a_mismatch_and_no_context_is_read(self, rt, gh):
        rt.documents.pin(**GH_PIN)
        gh.handlers["get_document_identity"] = gh_identity(document_id="99999999-0000-0000-0000-000000000000")
        gh.requests.clear()
        view = rt.composer.preview("selection")
        assert view["status"] == "error" and view["code"] == "IDENTITY_MISMATCH"
        assert view["bridgeState"] == "identity-mismatch"
        assert gh.commands() == ["get_document_identity"], "nothing but the identity check may be sent"

    def test_a_context_from_another_document_is_never_used(self, rt, gh):
        rt.documents.pin(**GH_PIN)
        handlers = default_gh_handlers()
        other = dict(handlers["get_canvas_context"])
        other["definition"] = {**other["definition"], "documentId": "99999999-0000-0000-0000-000000000000"}
        gh.handlers["get_canvas_context"] = other
        view = rt.composer.preview("selection")
        assert view["status"] == "error" and view["code"] == "IDENTITY_MISMATCH"

    def test_closed_document_is_document_not_open(self, rt, gh):
        from .fakes import gh_error
        rt.documents.pin(**GH_PIN)
        gh.handlers["get_document_identity"] = gh_error("HANDLER_ERROR", "No active document.")
        view = rt.composer.preview("selection")
        assert view["status"] == "error" and view["code"] == "DOCUMENT_NOT_OPEN"

    def test_bridge_off_and_busy_are_reported_not_retried(self, rt, gh, monkeypatch):
        from .fakes import free_port, gh_error
        rt.documents.pin(**GH_PIN)
        gh.handlers["get_document_identity"] = gh_error("BUSY")
        gh.requests.clear()
        assert rt.composer.preview("selection")["code"] == "BUSY"
        assert gh.commands() == ["get_document_identity"], "exactly one attempt"
        monkeypatch.setattr(gh_bridge, "GH_PORT", free_port())
        view = rt.composer.preview("selection")
        assert view["code"] == "BRIDGE_OFF" and view["bridgeState"] == "off"

    def test_no_document_pinned_is_project_data_only(self, rt, gh):
        view = rt.composer.preview("selection")
        assert view["status"] == "ok" and view["scope"] == "none" and view["requestedScope"] == "selection"
        assert view["summary"]["document"] is None and view["summary"]["objects"] == 0
        assert gh.connections == 0, "no document pinned means no bridge read"
        assert _json_part(view["payload"])["snapshot"] is None

    def test_empty_selection_is_disclosed(self, rt, gh):
        gh.handlers["get_selection"] = {"selection": []}
        rt.documents.pin(**GH_PIN)
        view = rt.composer.preview("selection")
        assert view["status"] == "ok" and view["summary"]["emptySelection"] is True and view["summary"]["objects"] == 0

    def test_dg_backend_down_is_a_missing_marker_not_a_failure(self, rt, dg):
        dg.routes[f"/data-service/rules/{PROJECT}"] = (500, {"detail": "boom"})
        rt.documents.pin(**GH_PIN)
        view = rt.composer.preview("selection")
        assert view["status"] == "ok" and view["summary"]["rules"] == 0
        assert {"what": "rules", "reason": "DG_UNAVAILABLE"} in view["missing"]

    def test_rules_denied_is_named(self, rt, dg):
        dg.routes[f"/data-service/rules/{PROJECT}"] = (403, {"detail": {"code": "PROJECT_FORBIDDEN"}})
        view = rt.composer.preview("none")
        assert {"what": "rules", "reason": "ACCESS_DENIED"} in view["missing"]

    def test_whole_definition_takes_every_node_and_needs_consent(self, rt):
        rt.documents.pin(**GH_PIN)
        view = rt.composer.preview("whole-definition")
        assert view["scope"] == "whole-definition" and view["requiresConsent"] is True
        assert view["summary"]["objects"] == 5
        assert len(_json_part(view["payload"])["snapshot"]["nodes"]) == 5

    def test_unknown_scope_is_rejected(self, rt):
        with pytest.raises(ContextError) as exc:
            rt.composer.preview("everything")
        assert exc.value.code == "SCOPE_INVALID"

    def test_no_credentials_is_a_named_outcome(self, rt):
        credentials.clear()
        view = rt.composer.preview("none")
        assert view["status"] == "error" and view["code"] == "CREDENTIALS_MISSING"


class TestLimits:
    def test_more_than_200_objects_are_cut_and_disclosed(self, rt, gh):
        nodes = [gh_node(i, params=1) for i in range(1, 202)]
        gh.handlers.update(default_gh_handlers(nodes=nodes, selection=[n["instanceId"] for n in nodes]))
        rt.documents.pin(**GH_PIN)
        view = rt.composer.preview("selection")
        assert view["summary"]["objects"] == 200
        assert {"what": "objects", "kept": 200, "total": 201} in view["truncation"]
        assert len(_json_part(view["payload"])["snapshot"]["nodes"]) == 200

    def test_more_than_50_parameters_per_object_are_cut_and_disclosed(self, rt, gh):
        nodes = [gh_node(1, params=51), gh_node(2, params=3)]
        gh.handlers.update(default_gh_handlers(nodes=nodes, selection=[n["instanceId"] for n in nodes]))
        rt.documents.pin(**GH_PIN)
        view = rt.composer.preview("selection")
        assert view["summary"]["parameters"] == 53
        assert {"what": "parameters", "kept": 53, "total": 54} in view["truncation"]
        first = _json_part(view["payload"])["snapshot"]["nodes"][0]
        assert len(first["inputParams"]) == 50

    def test_payload_is_cut_to_256_kib_by_dropping_objects(self, rt, gh):
        nodes = []
        for i in range(1, 151):
            node = gh_node(i, params=1)
            node["name"] = "x" * 5000
            nodes.append(node)
        gh.handlers.update(default_gh_handlers(nodes=nodes, selection=[n["instanceId"] for n in nodes]))
        rt.documents.pin(**GH_PIN)
        view = rt.composer.preview("selection")
        assert view["summary"]["bytes"] <= SNAPSHOT_LIMITS["max_bytes"]
        assert len(view["payload"].encode("utf-8")) == view["summary"]["bytes"]
        kept = view["summary"]["objects"]
        assert 0 < kept < 150
        assert {"what": "objects", "kept": kept, "total": 150} in view["truncation"]
        assert len(_json_part(view["payload"])["snapshot"]["nodes"]) == kept
        assert any(t["what"] == "bytes" and t["total"] > SNAPSHOT_LIMITS["max_bytes"] for t in view["truncation"])


class TestSend:
    def test_the_message_embeds_the_preview_payload_byte_for_byte(self, rt):
        rt.documents.pin(**GH_PIN)
        view = rt.composer.preview("selection")
        plan = rt.composer.prepare_send(view["previewId"], "Is this too tall?")
        assert plan.message.startswith(view["payload"]) and plan.message.endswith("Is this too tall?")
        assert plan.scope == "selection" and plan.consent is False

    def test_unknown_preview_is_refused(self, rt):
        with pytest.raises(ContextError) as exc:
            rt.composer.prepare_send("pv_nope", "hi")
        assert exc.value.code == "PREVIEW_UNKNOWN"

    def test_a_preview_is_stale_after_a_re_pin(self, rt):
        rt.documents.pin(**GH_PIN)
        view = rt.composer.preview("selection")
        rt.documents.pin(**GH_PIN)
        with pytest.raises(ContextError) as exc:
            rt.composer.prepare_send(view["previewId"], "hi")
        assert exc.value.code == "PREVIEW_STALE"

    def test_a_preview_of_another_scope_is_refused(self, rt, dg):
        rt.documents.pin(**GH_PIN)
        view = rt.composer.preview("selection")
        credentials.set(token=TOKEN, expires_at=time.time() + 600, relay_base_url=dg.base, user="alice",
                        company="acme", project="other-project")
        with pytest.raises(ContextError) as exc:
            rt.composer.prepare_send(view["previewId"], "hi")
        assert exc.value.code == "PREVIEW_STALE"

    def test_a_requested_scope_that_differs_from_the_preview_is_refused(self, rt):
        rt.documents.pin(**GH_PIN)
        view = rt.composer.preview("selection")
        with pytest.raises(ContextError) as exc:
            rt.composer.prepare_send(view["previewId"], "hi", scope="whole-definition")
        assert exc.value.code == "PREVIEW_SCOPE_MISMATCH"

    def test_empty_text_is_refused(self, rt):
        view = rt.composer.preview("none")
        with pytest.raises(ContextError):
            rt.composer.prepare_send(view["previewId"], "   ")


@pytest.fixture
def agent_home(rt):
    from hermes_constants import get_hermes_home
    lines = ["auxiliary:", "  title_generation:", "    model_upgrade_enabled: false", ""]
    (Path(get_hermes_home()) / "config.yaml").write_text("\n".join(lines), encoding="utf-8")


class TestWireIdentity:
    def test_the_request_body_the_relay_receives_contains_the_previewed_payload_exactly(self, rt, agent_home):
        relay = FakeRelay()
        try:
            rt.documents.pin(**GH_PIN)
            view = rt.composer.preview("selection")
            # the preview is done: from now on the relay is the model route (same user / company / project)
            credentials.set(token=TOKEN, expires_at=time.time() + 600, relay_base_url=relay.base, user="alice",
                            company="acme", project=PROJECT)
            plan = rt.composer.prepare_send(view["previewId"], "Is this too tall?")
            agent = server._make_agent("sid-wire", "key-wire")
            result = agent.run_conversation(plan.message)
            assert result["final_response"] == "hello"
            (post,) = relay.chat_posts()
            user_messages = [m for m in post["body"]["messages"] if m["role"] == "user"]
            assert user_messages[-1]["content"] == plan.message
            assert view["payload"] in post["raw"].decode("utf-8") or json.dumps(view["payload"])[1:-1] in post["raw"].decode("utf-8")
            assert user_messages[-1]["content"].startswith(view["payload"]), "preview == payload, byte for byte"
            assert _hdr(post["headers"], "X-DeGram-Context-Scope") == "selection"
            assert _hdr(post["headers"], "X-DeGram-Whole-Definition-Consent") is None
            assert TOKEN not in post["raw"].decode("utf-8")
        finally:
            relay.close()


class TestRpc:
    def rpc(self, method, params=None, rid=1):
        return server.handle_request({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})

    def test_list_pin_preview_send_round_trip(self, rt, monkeypatch):
        listing = self.rpc("degram.documents.list")["result"]
        assert any(g["app"] == "grasshopper" for g in listing["groups"]) and listing["pinned"] is None
        pinned = self.rpc("degram.documents.pin", GH_PIN)["result"]
        assert pinned["status"] == "ok" and pinned["pinned"]["app"] == "grasshopper"
        view = self.rpc("degram.context.preview", {"scope": "selection"})["result"]
        assert view["status"] == "ok" and view["previewId"]
        submitted = []
        monkeypatch.setitem(server._methods, "prompt.submit",
                            lambda rid, params: submitted.append(params) or server._ok(rid, {"status": "streaming"}))
        sent = self.rpc("degram.context.send", {"session_id": "s1", "previewId": view["previewId"], "text": "hi"})
        assert sent["result"]["status"] == "ok" and sent["result"]["submit"] == {"status": "streaming"}
        assert submitted[0]["session_id"] == "s1" and submitted[0]["text"].startswith(view["payload"])

    def test_list_can_ask_one_bridge_only(self, rt):
        """Plan 1301-14: the picker loads each bridge group independently, one call per application."""
        only = self.rpc("degram.documents.list", {"app": "grasshopper"})["result"]
        assert only["status"] == "ok" and [g["app"] for g in only["groups"]] == ["grasshopper"]
        assert only["groups"][0]["documents"], "the GH group carries its open document"
        everything = self.rpc("degram.documents.list")["result"]
        assert len(everything["groups"]) >= 1 and "grasshopper" in {g["app"] for g in everything["groups"]}

    def test_list_for_an_unknown_bridge_is_a_bad_request(self, rt):
        reply = self.rpc("degram.documents.list", {"app": "rhino-mesh"})
        assert reply["error"]["data"]["code"] == "BAD_REQUEST"

    def test_a_stale_preview_is_a_named_rpc_error(self, rt):
        self.rpc("degram.documents.pin", GH_PIN)
        view = self.rpc("degram.context.preview", {"scope": "selection"})["result"]
        self.rpc("degram.documents.pin", GH_PIN)
        reply = self.rpc("degram.context.send", {"session_id": "s1", "previewId": view["previewId"], "text": "hi"})
        assert reply["error"]["data"]["code"] == "PREVIEW_STALE"

    def test_pin_failure_is_an_outcome_result(self, rt):
        reply = self.rpc("degram.documents.pin", {"app": "grasshopper",
                                                  "identity": {"documentId": "ffffffff-0000-0000-0000-000000000000"}})
        assert reply["result"]["status"] == "error" and reply["result"]["code"] in {"DOCUMENT_NOT_OPEN",
                                                                                     "IDENTITY_MISMATCH"}

    def test_pin_with_a_null_app_unpins(self, rt):
        self.rpc("degram.documents.pin", GH_PIN)
        reply = self.rpc("degram.documents.pin", {"app": None})["result"]
        assert reply["status"] == "ok" and reply["pinned"] is None and rt.documents.pinned is None

    def test_all_rpcs_refuse_outside_variant_degram(self, rt, monkeypatch):
        monkeypatch.delenv("HERMES_DEGRAM")
        calls = {"degram.documents.list": {}, "degram.documents.pin": GH_PIN,
                 "degram.context.preview": {"scope": "selection"},
                 "degram.context.send": {"session_id": "s", "previewId": "pv_x", "text": "t"},
                 "degram.context.cancel": {}}
        for method, params in calls.items():
            reply = self.rpc(method, params)
            assert reply["error"]["data"]["code"] == "NOT_DEGRAM", method

    def test_a_running_session_refuses_a_send(self, rt, monkeypatch):
        self.rpc("degram.documents.pin", GH_PIN)
        view = self.rpc("degram.context.preview", {"scope": "selection"})["result"]
        monkeypatch.setitem(server._sessions, "busy-sid", {"running": True})
        reply = self.rpc("degram.context.send", {"session_id": "busy-sid", "previewId": view["previewId"], "text": "x"})
        assert reply["error"]["data"]["code"] == "SESSION_BUSY"
        server._sessions.pop("busy-sid", None)

    def test_clearing_credentials_drops_the_pin_and_previews(self, rt):
        self.rpc("degram.documents.pin", GH_PIN)
        view = self.rpc("degram.context.preview", {"scope": "selection"})["result"]
        assert self.rpc("degram.credentials.clear")["result"]["ok"] is True
        assert rt.documents.pinned is None
        with pytest.raises(ContextError):
            rt.composer.prepare_send(view["previewId"], "hi")


class TestPreviewBudget:
    """1301-19, G-14: the preview reads the bridge and the DG rules with bounded timeouts (worst case 40 s < 45 s)."""

    def test_the_preview_passes_its_deadlines_down(self, rt, monkeypatch):
        from degram_variant import context_composer
        seen = {}
        real_rules = rt.composer._dg.get_rules
        real_snapshot = rt.documents.read_snapshot

        def rules(cancel=None, read_timeout_s=None):
            seen["rules"] = read_timeout_s
            return real_rules(cancel, read_timeout_s=read_timeout_s)

        def snapshot(scope, project, cancel=None, deadline_s=None):
            seen["bridge"] = deadline_s
            return real_snapshot(scope, project, cancel, deadline_s=deadline_s)

        monkeypatch.setattr(rt.composer._dg, "get_rules", rules)
        monkeypatch.setattr(rt.documents, "read_snapshot", snapshot)
        rt.documents.pin(**GH_PIN)
        assert rt.composer.preview("selection")["status"] == "ok"
        assert seen == {"rules": context_composer.PREVIEW_RULES_READ_TIMEOUT_S, "bridge": 20.0}

    def test_a_dg_that_is_slow_to_answer_is_dg_unavailable_within_the_rules_budget(self, rt, dg, monkeypatch):
        """The rules read uses the short timeout; the preview then lists rules as missing instead of timing out."""
        import httpx
        from degram_variant import dg_client
        seen = {}
        real = httpx.Client

        def client(*args, timeout=None, **kwargs):
            seen["timeout"] = timeout
            return real(*args, timeout=timeout, **kwargs)

        monkeypatch.setattr(dg_client.httpx, "Client", client)
        rt.documents.pin(**GH_PIN)
        rt.composer.preview("selection")
        assert seen["timeout"].read == 15.0 and seen["timeout"].connect == 5.0
