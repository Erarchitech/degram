"""Per-scope Hermes profiles for variant degram (1301 D-19).

Each (user, company, project) scope maps to its own profile directory ``<home>/profiles/scope-<hash>``
with a regenerated, locked ``config.yaml``; two scopes never share ``state.db``, memory or logs, and
purging a scope deletes its whole profile. Electron main calls the CLI through the bundled interpreter
when a scope opens and on a 403 revoke::

    python -m degram_variant.profiles ensure|purge --home H --user U [--company C] --project P
    python -m degram_variant.profiles purge-project --home H --user U --project P
    python -m degram_variant.profiles cleanup-legacy --home H [--keep-json JSON]

The profile name is only a hash of the scope, so the directory listing does not disclose users or
projects. Every path is resolved and must sit directly under ``<home>/profiles``.

Plan 1301-20 (G-15, D-19, D-30): every profile carries ``degram-scope.json`` (user, company, project,
createdAt; never a token) so that access lost to a project purges that user's profiles of the project under
every company key, not only the key it was last opened under. A profile made before manifests existed gets
its manifest back-filled when ``ensure`` meets it; ``cleanup-legacy`` removes the ones still without a
manifest exactly once (marker ``degram-legacy-cleanup.done`` in the profiles root).
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
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NamedTuple, Sequence

TEMPLATE_PATH = Path(__file__).with_name("config_template.yaml")
PROFILE_PREFIX = "scope-"
MANIFEST_NAME = "degram-scope.json"
LEGACY_MARKER = "degram-legacy-cleanup.done"
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


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_manifest(path: Path) -> dict | None:
    """The validated manifest of a profile directory, or None (missing, unreadable, malformed)."""
    try:
        data = json.loads((path / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    user, company, project, created = data.get("user"), data.get("company"), data.get("project"), data.get("createdAt")
    if not (isinstance(user, str) and user.strip() and isinstance(project, str) and project.strip()):
        return None
    if company is not None and not isinstance(company, str):
        return None
    return {"user": user.strip(), "company": (company or "").strip() or None, "project": project.strip(),
            "createdAt": created if isinstance(created, str) else None}


def _write_manifest(path: Path, scope: Scope) -> None:
    """Write ``<profile>/degram-scope.json`` atomically. Fixed fields only (user, company, project,
    createdAt): never a token. An existing manifest of the same scope keeps its ``createdAt``."""
    user = scope.user.strip()
    project = scope.project.strip()
    company = (scope.company or "").strip() or None
    existing = _read_manifest(path)
    same = bool(existing) and (existing["user"], existing["company"], existing["project"]) == (user, company, project)
    payload = {
        "user": user,
        "company": company,
        "project": project,
        "createdAt": (existing["createdAt"] if same and existing["createdAt"] else None) or _now(),
    }
    fd, tmp = tempfile.mkstemp(prefix=MANIFEST_NAME + ".", suffix=".tmp", dir=str(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        os.replace(tmp, path / MANIFEST_NAME)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _scope_profile_dirs(home: Path) -> list[Path]:
    """Every ``scope-*`` directory directly under ``<home>/profiles`` that stays inside it."""
    root = home / "profiles"
    if not root.is_dir():
        return []
    found: list[Path] = []
    for entry in sorted(root.iterdir(), key=lambda p: p.name):
        if not entry.name.startswith(PROFILE_PREFIX):
            continue
        try:
            found.append(profile_path(home, entry.name))
        except ProfilePathError:
            continue  # a junction/symlink that leads elsewhere is never followed
    return [p for p in found if p.is_dir()]


def ensure_scope_profile(home: str | os.PathLike, scope: Any, *, revit_command: str | None = None,
                         revit_args: Sequence[str] | None = None) -> dict:
    """Create the scope's profile directory and (re)write its config from the template. Existing state
    (state.db, memory, logs) is never touched. The scope manifest is written first (a profile is never on disk
    without its owner) and back-filled when the directory predates manifests. Returns ``{"profile", "path"}``."""
    home = _checked_home(home)
    scope = _as_scope(scope)
    name = profile_name_for_scope(*scope)  # validates the scope before anything touches the disk
    path = profile_path(home, name)
    cfg = _render_config(revit_command, revit_args)
    from utils import atomic_yaml_write

    path.mkdir(parents=True, exist_ok=True)
    _write_manifest(path, scope)
    atomic_yaml_write(path / "config.yaml", cfg)
    return {"profile": name, "path": str(path)}


def _remove_readonly(func, target, exc) -> None:  # shutil.rmtree onexc hook
    os.chmod(target, stat.S_IWRITE)
    func(target)


def _remove_tree(path: Path, name: str) -> None:
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


def purge_scope_profile(home: str | os.PathLike, scope: Any) -> dict:
    """Delete the whole profile of ``scope`` (state.db, memory, logs, sessions). Idempotent. Returns
    ``{"profile", "path", "removed"}``; ``removed`` is False when there was nothing to delete."""
    home = _checked_home(home)
    scope = _as_scope(scope)
    name = profile_name_for_scope(*scope)
    path = profile_path(home, name)
    if not path.exists():
        return {"profile": name, "path": str(path), "removed": False}
    _remove_tree(path, name)
    return {"profile": name, "path": str(path), "removed": True}


def purge_project_profiles(home: str | os.PathLike, user: Any, project: Any) -> list[str]:
    """Delete every profile whose manifest names ``user`` and ``project``, whatever company it was opened
    under (G-15). Returns the removed profile names. Profiles without a manifest are not touched here."""
    home = _checked_home(home)
    user = _component("user", user, required=True)
    project = _component("project", project, required=True)
    removed: list[str] = []
    for path in _scope_profile_dirs(home):
        manifest = _read_manifest(path)
        if manifest and manifest["user"] == user and manifest["project"] == project:
            _remove_tree(path, path.name)
            removed.append(path.name)
    return removed


def cleanup_legacy_profiles(home: str | os.PathLike, keep: Sequence[Any] = ()) -> dict:
    """One-time cleanup of profiles made before manifests existed (D-30). The first run first back-fills the
    manifest of every profile that matches a scope in ``keep`` (the signed-in user's current scopes), then
    removes each remaining profile without a valid manifest, then writes ``degram-legacy-cleanup.done`` in
    the profiles root. Later runs do nothing. A profile that cannot be removed is reported in ``failed`` and
    the marker is not written, so the next sign-in retries."""
    home = _checked_home(home)
    root = home / "profiles"
    marker = root / LEGACY_MARKER
    if marker.exists():
        return {"ran": False, "backfilled": [], "removed": [], "failed": []}
    backfilled: list[str] = []
    for item in keep:
        scope = _as_scope(item)
        path = profile_path(home, profile_name_for_scope(*scope))
        if path.is_dir() and _read_manifest(path) is None:
            _write_manifest(path, scope)
            backfilled.append(path.name)
    removed: list[str] = []
    failed: list[str] = []
    for path in _scope_profile_dirs(home):
        if _read_manifest(path) is not None:
            continue
        try:
            _remove_tree(path, path.name)
            removed.append(path.name)
        except OSError:
            failed.append(path.name)
    if not failed:
        root.mkdir(parents=True, exist_ok=True)
        marker.write_text(_now(), encoding="utf-8")
    return {"ran": True, "backfilled": backfilled, "removed": removed, "failed": failed}


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
    purge_project = sub.add_parser("purge-project")
    purge_project.add_argument("--home", required=True)
    purge_project.add_argument("--user", required=True)
    purge_project.add_argument("--project", required=True)
    cleanup = sub.add_parser("cleanup-legacy")
    cleanup.add_argument("--home", required=True)
    cleanup.add_argument("--keep-json", default="[]")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "purge-project":
            result: Any = purge_project_profiles(args.home, args.user, args.project)
        elif args.command == "cleanup-legacy":
            keep = json.loads(args.keep_json)
            if not isinstance(keep, list):
                raise ValueError("--keep-json must be a JSON list of scopes")
            result = cleanup_legacy_profiles(args.home, [_as_scope(item) for item in keep])
        else:
            scope = Scope(args.user, args.company, args.project)
            if args.command == "ensure":
                result = ensure_scope_profile(args.home, scope, revit_command=args.revit_command,
                                              revit_args=args.revit_arg)
            else:
                result = purge_scope_profile(args.home, scope)
    except (ValueError, OSError, TypeError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
