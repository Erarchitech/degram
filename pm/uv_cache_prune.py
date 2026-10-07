"""Exact-to-lock pruning for uv caches.

The lock is the contract for anything downstream consumes wholesale: a
shipped bundle payload and a rolling CI cache snapshot both must not carry
wheels the project's uv.lock cannot resolve. Rolling caches accumulate
entries for superseded pins (prefix restores across dependency changes);
pruning to the lock keeps every consumer exact without discarding wheels
the current lock still needs (unlike ``uv cache prune --ci``).
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path


def lock_package_names(source_repo: Path) -> set[str]:
    """Dist names the lock can resolve; the exactness contract for a cache."""
    import tomllib

    data = tomllib.loads((source_repo / "uv.lock").read_text(encoding="utf-8"))
    return {entry["name"].lower().replace("_", "-") for entry in data["package"]}


def prune_uv_cache_to_lock(cache: Path, source_repo: Path) -> int:
    """Delete cache entries for dists the lock cannot resolve.

    Unidentifiable buckets (no dist-info) survive — pruning fails open for
    unknown layouts, never for identifiable stale pins. Returns the pruned
    entry count for the build log.
    """
    keep = lock_package_names(source_repo)
    return _prune(cache, lambda name: name not in keep)


def prune_uv_cache_dists(cache: Path, drop: set[str]) -> int:
    """Delete cache entries of the named dists (a variant that ships without some
    extras must not ship their wheels either). Same layout rules as
    ``prune_uv_cache_to_lock``; returns the pruned entry count."""
    names = {n.lower().replace("_", "-") for n in drop}
    return _prune(cache, lambda name: name in names)


def prune_uv_cache_to_dists(cache: Path, keep: set[str]) -> int:
    """Delete cache entries of every dist outside ``keep`` (a slim payload ships wheels only for what its venv
    actually installed, so an offline rebuild of that same set still resolves)."""
    names = {n.lower().replace("_", "-") for n in keep}
    return _prune(cache, lambda name: name not in names)


def _prune(cache: Path, should_drop) -> int:
    dist_info = re.compile(r"([A-Za-z0-9_.]+?)-\d[^-]*\.dist-info")

    def dist_name(bucket: Path) -> str | None:
        for marker_file in bucket.glob("*.dist-info"):
            match = dist_info.match(marker_file.name)
            if match:
                return match.group(1).lower().replace("_", "-")
        return None

    pruned = 0
    archive = cache / "archive-v0"
    if archive.is_dir():
        for bucket in archive.iterdir():
            if not bucket.is_dir():
                continue
            name = dist_name(bucket)
            if name is not None and should_drop(name):
                shutil.rmtree(bucket, ignore_errors=True)
                pruned += 1
    for family_dir in (*cache.glob("wheels-v*/pypi"), *cache.glob("sdists-v*/pypi")):
        if not family_dir.is_dir():
            continue
        for entry in family_dir.iterdir():
            if entry.is_dir() and should_drop(entry.name.lower().replace("_", "-")):
                shutil.rmtree(entry, ignore_errors=True)
                pruned += 1
    return pruned
