"""Per-scope Hermes profiles for variant degram (1301 D-19).

Each (user, company, project) scope maps to its own profile directory ``<home>/profiles/scope-<hash>``
with a regenerated, locked ``config.yaml``; two scopes never share ``state.db``, memory or logs, and
purging a scope deletes its whole profile. Electron main calls the CLI through the bundled interpreter
when a scope opens and on a 403 revoke::

    python -m degram_variant.profiles ensure|purge --home H --user U [--company C] --project P

The profile name is only a hash of the scope, so the directory listing does not disclose users or
projects. Every path is resolved and must sit directly under ``<home>/profiles``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import time
from pathlib import Path
from typing import Any, NamedTuple, Sequence

TEMPLATE_PATH = Path(__file__).with_name("config_template.yaml")
PROFILE_PREFIX = "scope-"
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
_SEPARATOR = chr(0x1F)


class ProfilePathError(ValueError):
    """A profile path that is not directly under ``<home>/profiles``."""


class Scope(NamedTuple):
    user: str
    company: str | None
    project: str


def _component(label: str, value: Any, *, required: bool) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string")
    value = value.strip()
    if required and not value:
        raise ValueError(f"{label} is required")
    if _SEPARATOR in value:
        raise ValueError(f"{label} must not contain the scope separator")
    return value


def profile_name_for_scope(user: Any, company: Any, project: Any) -> str:
    """``scope-`` + the first 16 hex of sha256(user, company, project joined by U+001F); company None is empty."""
    parts = (_component("user", user, required=True), _component("company", company, required=False),
             _component("project", project, required=True))
    digest = hashlib.sha256(_SEPARATOR.join(parts).encode("utf-8")).hexdigest()
    return PROFILE_PREFIX + digest[:16]


def _as_scope(scope: Any) -> Scope:
    if isinstance(scope, dict):
        return Scope(scope.get("user"), scope.get("company"), scope.get("project"))
    user, company, project = scope
    return Scope(user, company, project)


def profile_path(home: str | os.PathLike, name: str) -> Path:
    """``<home>/profiles/<name>`` resolved; refuses anything that is not directly under ``<home>/profiles``
    (a traversal in ``name``, or a symlink/junction that leads elsewhere)."""
    if not isinstance(name, str) or not _NAME_RE.match(name):
        raise ProfilePathError(f"invalid profile name {name!r}")
    root = (Path(home) / "profiles").resolve()
    resolved = (root / name).resolve()
    if resolved.parent != root or resolved.name != name:
        raise ProfilePathError(f"profile {name!r} resolves outside {root}")
    return resolved


def _checked_home(home: str | os.PathLike) -> Path:
    path = Path(home)
    if not path.is_absolute():
        raise ValueError("home must be an absolute path")
    return path


def _render_config(revit_command: str | None, revit_args: Sequence[str] | None) -> dict:
    from utils import fast_safe_load

    cfg = fast_safe_load(TEMPLATE_PATH.read_text(encoding="utf-8")) or {}
    if revit_command:
        revit = cfg["mcp_servers"]["revit"]
        revit["command"] = revit_command
        revit["args"] = list(revit_args or [])
        revit["enabled"] = True
    return cfg


def ensure_scope_profile(home: str | os.PathLike, scope: Any, *, revit_command: str | None = None,
                         revit_args: Sequence[str] | None = None) -> dict:
    """Create the scope's profile directory and (re)write its config from the template. Existing state
    (state.db, memory, logs) is never touched. Returns ``{"profile", "path"}``."""
    home = _checked_home(home)
    scope = _as_scope(scope)
    name = profile_name_for_scope(*scope)  # validates the scope before anything touches the disk
    path = profile_path(home, name)
    cfg = _render_config(revit_command, revit_args)
    from utils import atomic_yaml_write

    path.mkdir(parents=True, exist_ok=True)
    atomic_yaml_write(path / "config.yaml", cfg)
    return {"profile": name, "path": str(path)}


def _remove_readonly(func, target, exc) -> None:  # shutil.rmtree onexc hook
    os.chmod(target, stat.S_IWRITE)
    func(target)


def purge_scope_profile(home: str | os.PathLike, scope: Any) -> dict:
    """Delete the whole profile of ``scope`` (state.db, memory, logs, sessions). Idempotent. Returns
    ``{"profile", "path", "removed"}``; ``removed`` is False when there was nothing to delete."""
    home = _checked_home(home)
    scope = _as_scope(scope)
    name = profile_name_for_scope(*scope)
    path = profile_path(home, name)
    if not path.exists():
        return {"profile": name, "path": str(path), "removed": False}
    last_error: OSError | None = None
    for attempt in range(8):  # Windows: a just-stopped backend may still hold state.db for a moment
        try:
            shutil.rmtree(path, onexc=_remove_readonly)
            last_error = None
            break
        except OSError as exc:
            last_error = exc
            time.sleep(0.25 * (attempt + 1))
    if last_error is not None or path.exists():
        raise OSError(f"could not remove profile {name}: {last_error}")
    return {"profile": name, "path": str(path), "removed": True}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="degram_variant.profiles", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("ensure", "purge"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--home", required=True)
        cmd.add_argument("--user", required=True)
        cmd.add_argument("--company", default=None)
        cmd.add_argument("--project", required=True)
        if name == "ensure":
            cmd.add_argument("--revit-command", default=None)
            cmd.add_argument("--revit-arg", action="append", default=None)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    scope = Scope(args.user, args.company, args.project)
    try:
        if args.command == "ensure":
            result = ensure_scope_profile(args.home, scope, revit_command=args.revit_command, revit_args=args.revit_arg)
        else:
            result = purge_scope_profile(args.home, scope)
    except (ValueError, OSError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
