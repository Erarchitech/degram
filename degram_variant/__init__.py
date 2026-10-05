"""Variant degram: the locked-down DeGram agent (Phase 1301 plan 10).

Everything that makes Hermes a single-provider, allowlisted, egress-free, scope-isolated agent lives
here. The core carries only one-line hooks into this package (``is_degram()`` guards), so upstream
merges stay small. The variant is selected by the environment contract ``HERMES_DEGRAM=1``, which the
DeGram desktop sets for the backends it spawns.
"""
