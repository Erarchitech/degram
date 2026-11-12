"""A fake Revit adapter over MCP stdio (installed ``mcp`` 2.x SDK) for plan 1301-11 tests.

It stands in for ``apps/revit-mcp`` (plan 07): the same tool names, the same structured JSON text results, no Revit and
no pyRevit. Behaviour is switched per call by the JSON file named in ``FAKE_REVIT_MODE_FILE`` (so one running child
can play every scenario): ``{"mode": "ok" | "hang" | "error", "code": ..., "reason": ...}``. ``FAKE_REVIT_CALLS_FILE``
receives one JSON line per call (tool, arguments) so a test can assert what the client sent."""

from __future__ import annotations

import asyncio
import json
import os
import sys

from mcp.server import MCPServer

DOCS = [
    {"title": "tower.rvt", "pathName": "C:\\work\\tower.rvt", "creationGuid": "aaaaaaaa-0000-0000-0000-000000000001",
     "isActive": True, "isModified": False},
    {"title": "annex.rvt", "pathName": "", "creationGuid": "bbbbbbbb-0000-0000-0000-000000000002",
     "isActive": False, "isModified": True},
]


def _mode() -> dict:
    path = os.environ.get("FAKE_REVIT_MODE_FILE")
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    return {"mode": "ok"}


def _record(tool: str, arguments: dict) -> None:
    path = os.environ.get("FAKE_REVIT_CALLS_FILE")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"tool": tool, "arguments": arguments, "pid": os.getpid()}) + "\n")


async def _gate(tool: str, arguments: dict) -> str | None:
    """None to proceed, else the JSON text to answer with."""
    _record(tool, arguments)
    mode = _mode()
    if mode.get("mode") == "hang":
        await asyncio.sleep(60)
    if mode.get("mode") == "error":
        body = {"status": "error", "code": mode.get("code", "BRIDGE_OFF"), "error": "fake adapter error"}
        if mode.get("reason"):
            body["reason"] = mode["reason"]
        return json.dumps(body)
    return None


def build_server() -> MCPServer:
    server = MCPServer("fake-revit")

    @server.tool()
    async def get_revit_status() -> str:
        """Status of the fake Revit (carries the child pid)."""
        return await _gate("get_revit_status", {}) or json.dumps({"status": "ok", "pid": os.getpid(), "degramMode": os.environ.get("DEGRAM_MODE")})

    @server.tool()
    async def list_open_documents() -> str:
        """Open documents."""
        return await _gate("list_open_documents", {}) or json.dumps({"status": "ok", "documents": DOCS})

    @server.tool()
    async def get_selection_snapshot(identity: dict, max_elements: int = 200, max_parameters: int = 50) -> str:
        """Selection of the pinned document."""
        arguments = {"identity": identity, "max_elements": max_elements, "max_parameters": max_parameters}
        gated = await _gate("get_selection_snapshot", arguments)
        if gated:
            return gated
        elements = []
        for index in (1, 2):
            params = [{"name": f"P{p}", "storageType": "String", "unit": "", "displayValue": f"v{p}", "value": f"v{p}"}
                      for p in range(3)]
            elements.append({"uniqueId": f"uid-{index}", "elementId": 1000 + index, "category": "Walls",
                             "typeName": "Generic - 200mm", "parameters": params, "parametersTotal": 3})
        return json.dumps({"status": "ok", "emptySelection": False, "elements": elements,
                           "truncation": {"elementsTotal": 2, "elementsKept": 2, "parametersTruncated": 0,
                                          "maxElements": max_elements, "maxParameters": max_parameters}})

    # 1303-35: the advanced-mapping tools of the DG Revit connector. Each answers a canned, structured JSON text (or
    # whatever FAKE_REVIT_MODE_FILE says) and records its call, so a test sees what the client really sent.
    @server.tool()
    async def dg_model_overview() -> str:
        """Overview of the pinned model."""
        return await _gate("dg_model_overview", {}) or json.dumps({"status": "ok", "grids": [], "levels": []})

    @server.tool()
    async def dg_read_selection() -> str:
        """Selection of the pinned model."""
        return await _gate("dg_read_selection", {}) or json.dumps(
            {"status": "ok", "uniqueIds": ["uid-1"], "matched": 1, "truncated": False})

    @server.tool()
    async def dg_derive_definition(request_id: str) -> str:
        """Execute one frozen derive request."""
        return await _gate("dg_derive_definition", {"request_id": request_id}) or json.dumps(
            {"status": "ok", "derived": True, "requestId": request_id, "resultStatus": "ok"})

    @server.tool()
    async def dg_confirm_mapping_intent(intent_id: str) -> str:
        """Show the native challenge."""
        return await _gate("dg_confirm_mapping_intent", {"intent_id": intent_id}) or json.dumps(
            {"status": "ok", "decision": "confirmed", "intent": {"intentId": intent_id, "status": "confirmed"}})

    @server.tool()
    async def dg_preview_definition(intent_id: str) -> str:
        """Preview natively."""
        return await _gate("dg_preview_definition", {"intent_id": intent_id}) or json.dumps(
            {"status": "ok", "outcome": "completed", "operationId": "OP-0123456789abcdef", "result": None})

    @server.tool()
    async def dg_clear_definition_preview(intent_id: str) -> str:
        """Clear the owned preview."""
        return await _gate("dg_clear_definition_preview", {"intent_id": intent_id}) or json.dumps(
            {"status": "ok", "outcome": "completed", "operationId": "OP-0123456789abcdef", "result": None})

    @server.tool()
    async def a_tool_the_fork_adds_tomorrow(x: str = "") -> str:
        """A tool no classification names: it must never be admitted."""
        return await _gate("a_tool_the_fork_adds_tomorrow", {"x": x}) or json.dumps({"status": "ok"})

    return server


if __name__ == "__main__":
    sys.exit(build_server().run(transport="stdio"))
