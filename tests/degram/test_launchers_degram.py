"""F-07: DeGram never publishes a command into the user PATH.

Upstream ``expose_cli`` takes its Windows branch before the bundled-payload skip, so the
packaged DeGram minted ``%LOCALAPPDATA%\\DeGram\\home\\bin\\hermes.cmd`` and put that directory
first in HKCU PATH: a new shell's ``hermes`` then ran DeGram's payload instead of the owner's
Hermes. Variant degram owns no user-facing command at all.
"""

from hermes_cli import _launchers


def _forbid(*_args, **_kwargs):
    raise AssertionError("variant degram must not stage launchers or touch the user PATH")


def test_degram_exposes_nothing_on_windows(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_DEGRAM", "1")
    monkeypatch.setattr(_launchers, "_is_windows", lambda: True)
    monkeypatch.setattr(_launchers, "_expose_windows_user_bin", _forbid)
    monkeypatch.setattr(_launchers, "_register_windows_user_path", _forbid)

    for create in (True, False):
        assert _launchers.expose_cli(tmp_path, create=create) == {"ok": True, "skipped": "degram-owns-no-command"}


def test_degram_exposes_nothing_on_posix(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_DEGRAM", "1")
    monkeypatch.setattr(_launchers, "_is_windows", lambda: False)
    monkeypatch.setattr(_launchers, "ensure_install_launchers", _forbid)
    monkeypatch.setattr(_launchers, "_symlink_sealed_launchers", _forbid)

    assert _launchers.expose_cli(tmp_path) == {"ok": True, "skipped": "degram-owns-no-command"}


def test_stock_windows_path_is_unchanged(monkeypatch, tmp_path):
    monkeypatch.delenv("HERMES_DEGRAM", raising=False)
    monkeypatch.setattr(_launchers, "_is_windows", lambda: True)
    seen = []
    monkeypatch.setattr(_launchers, "_expose_windows_user_bin", lambda root, *, create: seen.append((root, create)) or {"ok": True})

    assert _launchers.expose_cli(tmp_path, create=False) == {"ok": True}
    assert seen == [(tmp_path.resolve(), False)]
