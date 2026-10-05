"""The normalized result of one snapshot read (plan 1301-11), whatever CAD host produced it."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Snapshot:
    """``objects`` are the host serializer's own dicts (GH: ``CgNode`` as DG serializes it; Revit: the
    ``get_selection_snapshot`` element), unmodified. ``params_key`` names the list inside an object that holds its
    parameters (GH ``inputParams``, Revit ``parameters``). ``extras`` carries whole-definition structure
    (wires, algorithms). ``source_truncation`` is what the host itself already cut (Revit), ``missing`` what it
    could not provide."""

    app: str
    document: dict[str, Any]
    objects: list[dict[str, Any]]
    params_key: str
    scope: str
    empty_selection: bool = False
    total_objects: int | None = None
    extras: dict[str, Any] = field(default_factory=dict)
    source_truncation: list[dict[str, Any]] = field(default_factory=list)
    missing: list[dict[str, Any]] = field(default_factory=list)
