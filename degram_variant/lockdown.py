"""Variant degram lockdown (1301 D-16/D-22): mode switch plus the closed surfaces.

Task 1 of plan 10 only needs the mode switch; the allowlists and guards extend this module.
"""

from __future__ import annotations

import os

ENV_DEGRAM = "HERMES_DEGRAM"


def is_degram() -> bool:
    """True only when the environment says ``HERMES_DEGRAM=1`` (exactly ``1``)."""
    return os.environ.get(ENV_DEGRAM) == "1"

# The relay's real context window is the operator's choice (the relay overrides the model); this
# conservative default stands in for every catalog/endpoint probe, which variant degram never makes.
# ``model.context_length`` in the generated profile config (config_template.yaml) wins over it.
DEGRAM_DEFAULT_CONTEXT_LENGTH = 128_000


def degram_context_length() -> int | None:
    """The fixed context length in variant degram, None elsewhere (hook in ``get_model_context_length``)."""
    return DEGRAM_DEFAULT_CONTEXT_LENGTH if is_degram() else None


def block_metadata_egress(url: str) -> None:
    """Variant degram makes no model-metadata/catalog probe (``agent/model_metadata_http.stream`` is the
    one choke point). Callers treat metadata as optional, so a refused probe reads as 'unreachable'."""
    if is_degram():
        raise ConnectionError(f"variant degram: model-metadata probe to {url!r} is disabled")
