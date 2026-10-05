"""Offline fakes for the DeGram read capabilities (plan 1301-11): a DG Canvas bridge listener on loopback
TCP, a DG backend (graph / rules) on loopback HTTP and an OpenAI-compatible SSE relay that records headers
and bodies. Nothing here talks to a real Grasshopper, Revit, DG stack or model provider."""

from __future__ import annotations

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

GH_DOC_ID = "11111111-2222-3333-4444-555555555555"


class Raw:
    """A reply sent verbatim (not wrapped in a DG bridge envelope)."""

    def __init__(self, obj: Any):
        self.obj = obj


def gh_envelope(result: Any) -> dict:
    return {"bridge": "dg", "version": 1, "status": "ok", "result": result}


def gh_error(code: str, message: str = "boom") -> dict:
    return {"bridge": "dg", "version": 1, "status": "error", "error": {"code": code, "message": message}}


def gh_identity(document_id: str = GH_DOC_ID, file_path: str | None = "C:/work/tower.gh", name: str = "tower.gh"):
    return {"documentId": document_id, "filePath": file_path, "displayName": name, "isModified": False,
            "capturedAt": "2026-10-05T10:00:00+00:00"}


def gh_node(index: int, params: int = 2) -> dict:
    guid = f"00000000-0000-0000-0000-{index:012d}"
    return {"instanceId": guid, "componentGuid": "aaaaaaaa-0000-0000-0000-000000000001", "name": f"Node {index}",
            "nickname": f"N{index}", "position": [float(index), 0.0], "isIntegerSlider": False,
            "inputParams": [{"instanceId": f"{guid[:-4]}p{p:03d}", "nickname": f"P{p}", "name": f"Param {p}", "index": p}
                            for p in range(params)]}


def gh_context(nodes: list[dict], document_id: str = GH_DOC_ID) -> dict:
    return {"schemaVersion": "cg-context-1", "project": "tower",
            "definition": {"documentId": document_id, "fileName": "tower.gh", "capturedAt": "2026-10-05T10:00:00Z"},
            "object": None, "algorithms": [], "untagged": {"nodeIds": [], "groups": []},
            "nodes": nodes, "wires": [], "warnings": []}


class FakeGh:
    """A loopback newline-JSON listener speaking the DG Canvas bridge wire protocol.

    ``handlers`` maps a command to a result (answered ``ok``), a callable ``(parameters) -> envelope-or-result`` or a
    ready ``bridge`` envelope dict. ``silent`` makes it accept and read the request but never answer."""

    def __init__(self, handlers: dict[str, Any] | None = None, *, silent: bool = False):
        self.handlers: dict[str, Any] = dict(handlers or {})
        self.silent = silent
        self.connections = 0
        self.requests: list[dict] = []
        self._closing = threading.Event()
        self._srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._srv.bind(("127.0.0.1", 0))
        self._srv.listen(8)
        self._srv.settimeout(0.1)
        self.port = self._srv.getsockname()[1]
        self.client_closed = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def commands(self) -> list[str]:
        return [r.get("type") for r in self.requests]

    def _serve(self):
        while not self._closing.is_set():
            try:
                conn, _ = self._srv.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self.connections += 1
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn: socket.socket):
        conn.settimeout(0.1)
        buf = b""
        try:
            while b"\n" not in buf and not self._closing.is_set():
                try:
                    chunk = conn.recv(65536)
                except socket.timeout:
                    continue
                if not chunk:
                    self.client_closed.set()
                    return
                buf += chunk
            request = json.loads(buf.split(b"\n", 1)[0])
            self.requests.append(request)
            if self.silent:
                while not self._closing.is_set():
                    try:
                        if conn.recv(1) == b"":
                            self.client_closed.set()
                            return
                    except socket.timeout:
                        continue
                    except OSError:
                        self.client_closed.set()
                        return
                return
            handler = self.handlers.get(request.get("type"))
            if handler is None:
                reply = gh_error("UNKNOWN_COMMAND", f"unknown command {request.get('type')}")
            else:
                value = handler(request.get("parameters") or {}) if callable(handler) else handler
                if isinstance(value, Raw):
                    reply = value.obj
                else:
                    reply = value if isinstance(value, dict) and value.get("bridge") == "dg" else gh_envelope(value)
            conn.sendall((json.dumps(reply) + "\n").encode("utf-8"))
        except OSError:
            self.client_closed.set()
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def close(self):
        self._closing.set()
        try:
            self._srv.close()
        except OSError:
            pass


class FakeDg:
    """A loopback DG backend. ``routes`` maps an exact path to ``(status, body)``; records every request."""

    def __init__(self, routes: dict[str, tuple[int, Any]] | None = None):
        self.routes: dict[str, tuple[int, Any]] = dict(routes or {})
        self.requests: list[dict] = []
        dg = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_a):
                pass

            def do_GET(self):
                dg.requests.append({"method": "GET", "path": self.path, "headers": dict(self.headers)})
                status, body = dg.routes.get(self.path, (404, {"detail": {"code": "NOT_FOUND"}}))
                payload = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}/data-service"

    def paths(self) -> list[str]:
        return [r["path"] for r in self.requests]

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def _chunk(delta, finish=None, usage=None):
    body = {"id": "c1", "object": "chat.completion.chunk", "created": 1, "model": "m",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    if usage:
        body["usage"] = usage
    return f"data: {json.dumps(body)}\n\n".encode()


class FakeRelay:
    """Records every request (headers, parsed body). Answers SSE, or ``error_body`` with ``status`` when != 200."""

    def __init__(self, status: int = 200, error_body: Any = None, script: list[dict] | None = None,
                 error_headers: dict | None = None):
        self.requests: list[dict] = []
        self.status = status
        self.error_headers = error_headers or {}
        self.script = list(script or [])  # one entry per chat POST: {"text": ..., "tool": name} (tool call)
        self.error_body = error_body if error_body is not None else {"error": {"message": "relay says no"}}
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
                raw = self.rfile.read(n) or b"{}"
                body = json.loads(raw)
                relay.requests.append({"method": "POST", "path": self.path, "headers": dict(self.headers),
                                       "body": body, "raw": raw})
                if relay.status != 200:
                    payload = json.dumps(relay.error_body).encode()
                    self.send_response(relay.status)
                    self.send_header("content-type", "application/json")
                    for key, value in relay.error_headers.items():
                        self.send_header(key, value)
                    self.send_header("content-length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                step = relay.script.pop(0) if relay.script else {"text": "hello"}
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()
                self.wfile.write(_chunk({"role": "assistant", "content": step.get("text", "")}))
                usage = {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}
                if step.get("tool"):
                    call = {"index": 0, "id": "call_1", "type": "function",
                            "function": {"name": step["tool"], "arguments": "{}"}}
                    self.wfile.write(_chunk({"tool_calls": [call]}))
                    self.wfile.write(_chunk({}, "tool_calls", usage))
                else:
                    self.wfile.write(_chunk({}, "stop", usage))
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}/data-service"

    def chat_posts(self) -> list[dict]:
        return [r for r in self.requests if r["method"] == "POST" and r["path"].endswith("/chat/completions")]

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def free_port() -> int:
    """A loopback port nothing listens on (bound and released)."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port
