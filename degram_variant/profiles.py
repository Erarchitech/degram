"""Environment-owned DeGram profiles, migration and scoped cleanup (1301-43).

Names hash UTF-8 ``dg-profile-v2 U+001F origin U+001F user U+001F company
U+001F project``. Legacy names are adopted only under a durable loopback ownership
claim, after Electron has stopped the related backends. No state leaves this home.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
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
from urllib.parse import urlsplit

TEMPLATE_PATH = Path(__file__).with_name("config_template.yaml")
PROFILE_PREFIX = "scope-"
MANIFEST_NAME = "degram-scope.json"
LEGACY_MARKER = "degram-legacy-cleanup.done"  # historical marker; never permits deletion
OWNERSHIP_NAME = "dg-environment-ownership.json"
MIGRATION_NAME = "degram-profile-migration.json"
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
_SEPARATOR = chr(0x1F)


class ProfilePathError(ValueError):
    """A profile path that is not directly under ``<home>/profiles``."""


class Scope(NamedTuple):
    user: str
    company: str | None
    project: str
    origin: str | None = None
    environment_id: str | None = None


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


def canonical_origin(value: Any) -> str:
    if not isinstance(value, str) or not value.strip() or any(c.isspace() for c in value.strip()):
        raise ValueError("origin must be a bare http(s) origin")
    raw = value.strip()
    try:
        url = urlsplit(raw)
        host = url.hostname
        port = url.port
        if (url.scheme not in ("http", "https") or not host or url.username is not None or
                url.password is not None or url.path not in ("", "/") or "?" in raw or "#" in raw or "\\" in raw):
            raise ValueError("origin must be a bare http(s) origin")
        host = host.lower()
        if ":" in host:
            host = "[" + ipaddress.IPv6Address(host).compressed + "]"
        else:
            host = host.encode("idna").decode("ascii")
            if not re.fullmatch(r"[a-z0-9.-]+", host):
                raise ValueError("invalid origin host")
        if url.scheme == "http" and host not in ("localhost", "127.0.0.1", "[::1]"):
            raise ValueError("remote HTTP origin is forbidden")
        suffix = "" if port is None or (url.scheme, port) in (("http", 80), ("https", 443)) else f":{port}"
        return f"{url.scheme}://{host}{suffix}"
    except (ValueError, UnicodeError) as exc:
        raise ValueError("origin must be a permitted bare http(s) origin") from exc


def environment_id_for_origin(origin: str) -> str:
    canonical = canonical_origin(origin)
    return "dg-env-v1-" + hashlib.sha256(f"dg-env-v1:{canonical}".encode("utf-8")).hexdigest()


def _environment(origin: Any, environment_id: Any) -> tuple[str, str]:
    canonical = canonical_origin(origin)
    expected = environment_id_for_origin(canonical)
    if environment_id != expected:
        raise ValueError("origin and environmentId do not match")
    return canonical, expected


def _legacy_name(user: Any, company: Any, project: Any) -> str:
    parts = (_component("user", user, required=True), _component("company", company, required=False),
             _component("project", project, required=True))
    return PROFILE_PREFIX + hashlib.sha256(_SEPARATOR.join(parts).encode("utf-8")).hexdigest()[:16]


def profile_name_for_scope(user: Any, company: Any, project: Any, origin: str,
                           environment_id: str | None = None) -> str:
    canonical, _ = _environment(origin, environment_id or environment_id_for_origin(origin))
    parts = ("dg-profile-v2", canonical, _component("user", user, required=True),
             _component("company", company, required=False), _component("project", project, required=True))
    return PROFILE_PREFIX + hashlib.sha256(_SEPARATOR.join(parts).encode("utf-8")).hexdigest()[:32]


def _as_scope(scope: Any) -> Scope:
    if isinstance(scope, dict):
        return Scope(scope.get("user"), scope.get("company"), scope.get("project"),
                     scope.get("origin"), scope.get("environmentId"))
    return Scope(*scope)


def profile_path(home: str | os.PathLike, name: str) -> Path:
    if not isinstance(name, str) or not _NAME_RE.fullmatch(name):
        raise ProfilePathError(f"invalid profile name {name!r}")
    root_path = Path(home) / "profiles"
    if root_path.is_symlink() or (hasattr(root_path, "is_junction") and root_path.is_junction()):
        raise ProfilePathError("profiles root must not be a link")
    root = root_path.resolve()
    candidate = root / name
    resolved = candidate.resolve()
    if resolved.parent != root or resolved.name != name or candidate.is_symlink() or (
            hasattr(candidate, "is_junction") and candidate.is_junction()):
        raise ProfilePathError(f"profile {name!r} resolves outside {root}")
    return resolved


def _checked_home(home: str | os.PathLike) -> Path:
    path = Path(home)
    if not path.is_absolute():
        raise ValueError("home must be an absolute path")
    return path


def _read_json(path: Path) -> dict:
    if path.is_symlink() or (path.exists() and path.stat().st_nlink > 1):
        raise ValueError("linked metadata is forbidden")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("metadata must be a JSON object")
    return data


def _write_json(path: Path, payload: dict) -> None:
    if path.exists() or path.is_symlink():
        _read_json(path)  # never overwrite malformed or linked ownership/state
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _legacy_origin(home: Path) -> str | None:
    path = home / OWNERSHIP_NAME
    if not path.exists():
        return None
    data = _read_json(path)
    if (data.get("version") != 1 or data.get("partition") != "persist:degram-dg" or
            data.get("stage") not in ("claimed", "adopted")):
        raise ValueError("invalid legacy ownership journal")
    origin = canonical_origin(data.get("origin"))
    if urlsplit(origin).hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("legacy ownership must be proven Developer loopback")
    return origin


def _resolve_environment(home: Path, origin: Any, environment_id: Any) -> tuple[str, str]:
    if origin is None and environment_id is None:
        origin = _legacy_origin(home)
        if origin is None:
            raise ValueError("explicit environment or proven legacy ownership is required")
        environment_id = environment_id_for_origin(origin)
    return _environment(origin, environment_id)


def _resolved_scope(home: Path, scope: Any) -> Scope:
    scope = _as_scope(scope)
    origin, env = _resolve_environment(home, scope.origin, scope.environment_id)
    return Scope(_component("user", scope.user, required=True),
                 _component("company", scope.company, required=False) or None,
                 _component("project", scope.project, required=True), origin, env)


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
    try:
        data = _read_json(path / MANIFEST_NAME)
        user = _component("user", data.get("user"), required=True)
        project = _component("project", data.get("project"), required=True)
        company = _component("company", data.get("company"), required=False) or None
        result = {"user": user, "company": company, "project": project, "createdAt": data.get("createdAt")}
        if data.get("version") not in (None, 2):
            return None
        if data.get("version") == 2 or "origin" in data or "environmentId" in data:
            origin, env = _environment(data.get("origin"), data.get("environmentId"))
            if data.get("version") != 2 or data["origin"] != origin:
                return None
            result.update(version=2, origin=origin, environmentId=env)
        return result
    except (OSError, ValueError, TypeError):
        return None


def _matches(manifest: dict | None, scope: Scope) -> bool:
    return bool(manifest) and all(manifest.get(k) == v for k, v in (
        ("user", scope.user), ("company", scope.company), ("project", scope.project),
        ("origin", scope.origin), ("environmentId", scope.environment_id)))


def _write_manifest(path: Path, scope: Scope, created_at: str | None = None) -> None:
    existing = _read_manifest(path)
    payload = {"version": 2, "user": scope.user, "company": scope.company, "project": scope.project,
               "origin": scope.origin, "environmentId": scope.environment_id,
               "createdAt": created_at or (existing or {}).get("createdAt") or _now()}
    _write_json(path / MANIFEST_NAME, payload)


def _scope_profile_dirs(home: Path) -> list[Path]:
    root = home / "profiles"
    profile_path(home, "safety-check")
    if not root.is_dir():
        return []
    found = []
    for entry in sorted(root.iterdir(), key=lambda p: p.name):
        if entry.name.startswith(PROFILE_PREFIX):
            try:
                path = profile_path(home, entry.name)
                if path.is_dir():
                    found.append(path)
            except ProfilePathError:
                continue
    return found


def _migration_journal(home: Path, origin: str) -> dict:
    path = home / MIGRATION_NAME
    if not path.exists():
        return {"version": 1, "origin": origin, "entries": {}}
    data = _read_json(path)
    if data.get("version") != 1 or data.get("origin") != origin or not isinstance(data.get("entries"), dict):
        raise ValueError("invalid profile migration journal")
    for old, entry in data["entries"].items():
        if not isinstance(entry, dict) or entry.get("stage") not in ("pending", "complete"):
            raise ValueError("invalid profile migration entry")
        scope = _resolved_scope(home, entry.get("scope"))
        if scope.origin != origin or old != _legacy_name(*scope[:3]):
            raise ValueError("invalid legacy migration identity")
        if entry.get("destination") != profile_name_for_scope(*scope):
            raise ValueError("invalid migration destination")
        profile_path(home, old)
        profile_path(home, entry["destination"])
    return data


def migration_candidates(home: str | os.PathLike) -> list[str]:
    home = _checked_home(home)
    origin = _legacy_origin(home)
    if origin is None:
        return []
    journal = _migration_journal(home, origin)
    names = {p.name for p in _scope_profile_dirs(home) if re.fullmatch(r"scope-[a-f0-9]{16}", p.name)}
    for old, entry in journal["entries"].items():
        if entry["stage"] == "pending":
            names.update((old, entry["destination"]))
    return sorted(names)


def migrate_legacy_profiles(home: str | os.PathLike, keep: Sequence[Any] = (), *, backend_stopped: bool = False) -> dict:
    home = _checked_home(home)
    origin = _legacy_origin(home)
    result = {"migrated": [], "reported": []}
    if origin is None:
        result["reported"] = migration_candidates_unowned(home)
        return result
    if not backend_stopped:
        raise ValueError("legacy profile backends must be stopped before migration")
    env = environment_id_for_origin(origin)
    journal = _migration_journal(home, origin)
    known = {}
    for item in keep:
        scope = _resolved_scope(home, item)
        if scope.origin == origin:
            known[_legacy_name(*scope[:3])] = scope
    candidates = {p.name for p in _scope_profile_dirs(home) if re.fullmatch(r"scope-[a-f0-9]{16}", p.name)}
    candidates.update(journal["entries"])
    for name in sorted(candidates):
        old = profile_path(home, name)
        entry = journal["entries"].get(name)
        manifest = _read_manifest(old) if old.exists() else None
        if entry:
            scope = _resolved_scope(home, entry["scope"])
        elif manifest and "origin" not in manifest and _legacy_name(manifest["user"], manifest["company"], manifest["project"]) == name:
            scope = Scope(manifest["user"], manifest["company"], manifest["project"], origin, env)
        elif manifest is None and not (old / MANIFEST_NAME).exists() and name in known:
            scope = known[name]
        else:
            result["reported"].append(name)
            continue
        destination = profile_path(home, profile_name_for_scope(*scope))
        if old.exists() and destination.exists():
            result["reported"].append(name)
            continue  # collision: preserve both directories byte-for-byte
        metadata = old / MANIFEST_NAME
        conflicting = manifest is not None and (
            "origin" in manifest or (manifest["user"], manifest["company"], manifest["project"]) != scope[:3])
        malformed = (metadata.exists() or metadata.is_symlink()) and manifest is None
        if old.exists() and (conflicting or malformed):
            result["reported"].append(name)
            continue
        if entry is None:
            entry = {"destination": destination.name, "stage": "pending",
                     "scope": {"user": scope.user, "company": scope.company, "project": scope.project,
                               "origin": origin, "environmentId": env},
                     "createdAt": (manifest or {}).get("createdAt")}
            journal["entries"][name] = entry
            _write_json(home / MIGRATION_NAME, journal)
        if old.exists():
            old.rename(destination)
        if not destination.is_dir():
            result["reported"].append(name)
            continue
        current = _read_manifest(destination)
        if (destination / MANIFEST_NAME).exists():
            if current is None or ("origin" in current and not _matches(current, scope)) or (
                    "origin" not in current and
                    (current["user"], current["company"], current["project"]) != scope[:3]):
                raise ValueError("migration destination belongs to another scope or is malformed")
        if not _matches(current, scope):
            _write_manifest(destination, scope, entry.get("createdAt"))
        if entry["stage"] != "complete":
            entry["stage"] = "complete"
            _write_json(home / MIGRATION_NAME, journal)
        result["migrated"].append(destination.name)
    return result


def migration_candidates_unowned(home: Path) -> list[str]:
    return [p.name for p in _scope_profile_dirs(home) if "origin" not in (_read_manifest(p) or {})]


def ensure_scope_profile(home: str | os.PathLike, scope: Any, *, revit_command: str | None = None,
                         revit_args: Sequence[str] | None = None) -> dict:
    home = _checked_home(home)
    scope = _resolved_scope(home, scope)
    name = profile_name_for_scope(*scope)
    path = profile_path(home, name)
    legacy = profile_path(home, _legacy_name(*scope[:3]))
    if _legacy_origin(home) == scope.origin and legacy.exists():
        raise ValueError("legacy profile migration is required before ensure")
    if path.exists() and not _matches(_read_manifest(path), scope):
        raise ValueError("profile manifest is malformed or belongs to another scope")
    cfg = _render_config(revit_command, revit_args)
    from utils import atomic_yaml_write
    path.mkdir(parents=True, exist_ok=True)
    _write_manifest(path, scope)
    atomic_yaml_write(path / "config.yaml", cfg)
    return {"profile": name, "path": str(path)}


def _remove_readonly(func, target, exc) -> None:
    os.chmod(target, stat.S_IWRITE)
    func(target)


def _remove_tree(path: Path, name: str) -> None:
    last_error: OSError | None = None
    for attempt in range(8):
        try:
            shutil.rmtree(path, onexc=_remove_readonly)
            return
        except OSError as exc:
            last_error = exc
            time.sleep(0.25 * (attempt + 1))
    raise OSError(f"could not remove profile {name}: {last_error}")


def purge_scope_profile(home: str | os.PathLike, scope: Any) -> dict:
    home = _checked_home(home)
    scope = _resolved_scope(home, scope)
    name = profile_name_for_scope(*scope)
    path = profile_path(home, name)
    if not path.exists():
        return {"profile": name, "path": str(path), "removed": False}
    if not _matches(_read_manifest(path), scope):
        raise ValueError("profile ownership is not proven")
    _remove_tree(path, name)
    return {"profile": name, "path": str(path), "removed": True}


def purge_project_profiles(home: str | os.PathLike, user: Any, project: Any, *,
                           origin: str | None = None, environment_id: str | None = None) -> list[str]:
    home = _checked_home(home)
    origin, env = _resolve_environment(home, origin, environment_id)
    user = _component("user", user, required=True)
    project = _component("project", project, required=True)
    removed = []
    for path in _scope_profile_dirs(home):
        manifest = _read_manifest(path)
        if manifest and _matches(manifest, Scope(user, manifest["company"], project, origin, env)):
            if path.name == profile_name_for_scope(user, manifest["company"], project, origin, env):
                _remove_tree(path, path.name)
                removed.append(path.name)
    return removed


def cleanup_legacy_profiles(home: str | os.PathLike, keep: Sequence[Any] = (), *,
                            origin: str | None = None, environment_id: str | None = None) -> dict:
    home = _checked_home(home)
    _resolve_environment(home, origin, environment_id)
    # D-30's old deletion sweep must never run before adoption. Ambiguous records stay
    # in place and are reported rather than destroyed; modern/inactive origins are ignored.
    reported = migration_candidates_unowned(home)
    return {"ran": True, "backfilled": [], "removed": [], "failed": reported}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="degram_variant.profiles", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("ensure", "purge", "purge-project", "cleanup-legacy", "migration-status", "migrate"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--home", required=True)
        cmd.add_argument("--origin")
        cmd.add_argument("--environment-id")
        if name in ("ensure", "purge", "purge-project"):
            cmd.add_argument("--user", required=True)
            cmd.add_argument("--project", required=True)
        if name in ("ensure", "purge"):
            cmd.add_argument("--company", default=None)
        if name == "ensure":
            cmd.add_argument("--revit-command", default=None)
            cmd.add_argument("--revit-arg", action="append", default=None)
        if name in ("cleanup-legacy", "migrate"):
            cmd.add_argument("--keep-json", default="[]")
        if name == "migrate":
            cmd.add_argument("--backend-stopped", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        environment = dict(origin=args.origin, environment_id=args.environment_id)
        if args.command == "migration-status":
            result: Any = migration_candidates(args.home)
        elif args.command in ("cleanup-legacy", "migrate"):
            keep = json.loads(args.keep_json)
            if not isinstance(keep, list):
                raise ValueError("--keep-json must be a JSON list of scopes")
            if args.command == "migrate":
                result = migrate_legacy_profiles(args.home, keep, backend_stopped=args.backend_stopped)
            else:
                result = cleanup_legacy_profiles(args.home, keep, **environment)
        elif args.command == "purge-project":
            result = purge_project_profiles(args.home, args.user, args.project, **environment)
        else:
            scope = Scope(args.user, args.company, args.project, args.origin, args.environment_id)
            result = (ensure_scope_profile(args.home, scope, revit_command=args.revit_command, revit_args=args.revit_arg)
                      if args.command == "ensure" else purge_scope_profile(args.home, scope))
    except (ValueError, OSError, TypeError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
