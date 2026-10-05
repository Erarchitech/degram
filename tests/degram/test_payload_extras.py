"""The DeGram payload is built on a Windows PC without a C or Rust toolchain (plan 1301-15).

The bundle builder runs ``uv sync --all-extras`` minus ``[tool.hermes] opt-in-extras``. Two extras
have no Windows wheel for the payload interpreter (CPython 3.14) and therefore compile from source:

* ``silk``    -> ``pilk``    (C extension: needs MSVC plus the Windows SDK)
* ``daytona`` -> ``obstore`` (Rust extension: needs a Rust toolchain)

Neither belongs to the read-only DeGram agent, so both are install-on-demand like ``kittentts``.
The extras stay declared, locked and installable through ``sync_venv([extra])``.
"""

from __future__ import annotations

from pathlib import Path

from pm.features import declared_extras, opt_in_extras

ROOT = Path(__file__).resolve().parents[2]

# Extras that must never be built into a payload on a machine with no native toolchain.
SOURCE_BUILD_EXTRAS = {"silk", "daytona"}


def test_extras_that_compile_from_source_are_opt_in():
    assert SOURCE_BUILD_EXTRAS <= set(opt_in_extras(ROOT))


def test_the_opt_in_extras_stay_declared_so_they_remain_installable_on_demand():
    assert SOURCE_BUILD_EXTRAS <= set(declared_extras(ROOT))


def test_the_existing_opt_in_extra_is_kept():
    assert "kittentts" in opt_in_extras(ROOT)
