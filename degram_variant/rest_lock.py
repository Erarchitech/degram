"""The DEGRAM_LOCKED catch-all of the dashboard REST surface (variant degram).

Kept apart from ``lockdown.py`` on purpose: FastAPI resolves handler annotations from module globals, so
this module imports fastapi at module level and must not use ``from __future__ import annotations``,
while ``lockdown.py`` is imported by hot, fastapi-free paths (the tool registry, the config loader).
"""

from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

DEGRAM_LOCKED = "DEGRAM_LOCKED"
REST_CATCH_ALL = "/api/{rest_of_path:path}"
LOCKED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]


async def _locked(request: Request, rest_of_path: str) -> JSONResponse:
    return JSONResponse(status_code=403, content={
        "detail": {"code": DEGRAM_LOCKED, "message": f"{request.url.path} is not available in DeGram"}})


def locked_route() -> APIRoute:
    return APIRoute(REST_CATCH_ALL, _locked, methods=LOCKED_METHODS, include_in_schema=False)
