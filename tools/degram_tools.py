"""The ``degram`` toolset (variant degram only): bounded, read-only access for the agent (1301 D-13..D-15, D-22).

Four tools, no parameters that could widen what they read, no write capability:

* ``degram_list_documents``: the open documents of every reachable bridge (GH, Revit) and the pinned one.
* ``degram_bridge_status``: one state per bridge (ready, pinned, busy, off, setup-incomplete, identity-mismatch).
* ``degram_document_snapshot``: the *selection* of the pinned document (identity re-checked first), bounded to 200
  objects / 50 parameters per object / 256 KiB with the cut disclosed. No scope argument: whole-definition scope exists
  only through the user's context card and its consent, never as a tool call.
* ``degram_project_graph``: graph nodes, relationships and rules of the *bound* project, read with the delegated token.
  No project argument: another project cannot be named.

Every failure is a structured outcome from the closed vocabulary (``spec/degram/OPERATIONAL-OUTCOMES.md``), never free
text and never a retry. The tools are unavailable outside variant degram (``check_fn``)."""

from __future__ import annotations

import json
from typing import Any

from tools.registry import no_cache_check_fn, registry

_NO_ARGS = {"type": "object", "properties": {}, "additionalProperties": False}
GRAPH_NODE_LIMIT = 200
GRAPH_REL_LIMIT = 400


@no_cache_check_fn
def _is_degram() -> bool:
    from degram_variant.lockdown import is_degram

    return is_degram()


def _outcome_json(fn) -> str:
    from degram_variant.outcomes import BridgeError

    try:
        return json.dumps(fn(), ensure_ascii=False)
    except BridgeError as exc:
        return json.dumps(exc.to_dict(), ensure_ascii=False)


def _list_documents(args: dict, **_kw) -> str:
    from degram_variant import runtime

    return _outcome_json(lambda: {"status": "ok", **runtime.get().documents.list()})


def _bridge_status(args: dict, **_kw) -> str:
    from degram_variant import runtime

    return _outcome_json(lambda: runtime.get().documents.status())


def _document_snapshot(args: dict, **_kw) -> str:
    from degram_variant import runtime

    return _outcome_json(lambda: runtime.get().composer.agent_snapshot())


def bounded_graph(graph: dict[str, Any], rules: list[dict[str, Any]], project: str, max_bytes: int) -> dict[str, Any]:
    """The project graph cut to ``GRAPH_NODE_LIMIT`` nodes, ``GRAPH_REL_LIMIT`` relationships and ``max_bytes``, with the
    cut disclosed. Relationships are kept only between kept nodes."""
    nodes = [n for n in graph.get("nodes") or [] if isinstance(n, dict)]
    rels = [r for r in graph.get("rels") or [] if isinstance(r, dict)]

    def build(count: int) -> dict[str, Any]:
        kept_nodes = nodes[:count]
        ids = {n.get("id") for n in kept_nodes}
        kept_rels = [r for r in rels if r.get("source") in ids and r.get("target") in ids][:GRAPH_REL_LIMIT]
        truncation = []
        if count < len(nodes):
            truncation.append({"what": "nodes", "kept": count, "total": len(nodes)})
        if len(kept_rels) < len(rels):
            truncation.append({"what": "rels", "kept": len(kept_rels), "total": len(rels)})
        return {"status": "ok", "project": project, "graph": {"nodes": kept_nodes, "rels": kept_rels},
                "rules": rules, "truncation": truncation}

    def size(value: dict[str, Any]) -> int:
        return len(json.dumps(value, ensure_ascii=False).encode("utf-8"))

    count = min(len(nodes), GRAPH_NODE_LIMIT)
    result = build(count)
    if size(result) > max_bytes:
        lo, hi = 0, count
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if size(build(mid)) <= max_bytes:
                lo = mid
            else:
                hi = mid - 1
        count = lo
        result = build(count)
    return result


def _project_graph(args: dict, **_kw) -> str:
    from degram_variant import runtime
    from degram_variant.context_composer import SNAPSHOT_LIMITS
    from degram_variant.credentials import DegramCredentialsError, credentials
    from degram_variant.outcomes import ACCESS_DENIED, DG_UNAVAILABLE, BridgeError

    def read() -> dict[str, Any]:
        try:
            info = credentials.require_info()
        except DegramCredentialsError as exc:
            raise BridgeError(exc.code, None, str(exc).split(": ", 1)[-1]) from exc
        dg = runtime.get().dg
        graph = dg.get_graph()
        missing: list[dict[str, Any]] = []
        try:
            rules = dg.get_rules()
        except BridgeError as exc:
            if exc.code not in (DG_UNAVAILABLE, ACCESS_DENIED):
                raise
            rules = []
            missing.append({"what": "rules", "reason": exc.code})
        result = bounded_graph(graph, rules, info.project, SNAPSHOT_LIMITS["max_bytes"])
        if missing:
            result["missing"] = missing
        return result

    return _outcome_json(read)


registry.register(
    name="degram_list_documents", toolset="degram", handler=_list_documents, check_fn=_is_degram,
    schema={"name": "degram_list_documents",
            "description": "List the open Grasshopper and Revit documents and which one is pinned. Read-only; pins nothing.",
            "parameters": _NO_ARGS})
registry.register(
    name="degram_bridge_status", toolset="degram", handler=_bridge_status, check_fn=_is_degram,
    schema={"name": "degram_bridge_status",
            "description": "State of each CAD bridge (ready, pinned, busy, off, setup-incomplete, identity-mismatch) with "
                           "the reason when it is not ready. Read-only.",
            "parameters": _NO_ARGS})
registry.register(
    name="degram_document_snapshot", toolset="degram", handler=_document_snapshot, check_fn=_is_degram,
    schema={"name": "degram_document_snapshot",
            "description": "Read the current selection of the pinned CAD document (objects with their parameters), "
                           "bounded in size; truncation and missing data are listed. Read-only; fails with "
                           "IDENTITY_MISMATCH if the document answering is not the pinned one.",
            "parameters": _NO_ARGS})
registry.register(
    name="degram_project_graph", toolset="degram", handler=_project_graph, check_fn=_is_degram,
    schema={"name": "degram_project_graph",
            "description": "Read the Design Grammar graph (nodes, relationships) and the rules of the current project, "
                           "bounded in size. Read-only; always the user's current project.",
            "parameters": _NO_ARGS})
