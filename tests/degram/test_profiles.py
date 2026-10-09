"""Variant degram: one isolated Hermes profile per (user, company, project) scope (plan 1301-10 task 3, D-19).

The profile directory name is a stable hash of the scope, its config is regenerated from the template on
every ensure (a user edit never survives), two scopes never share a ``state.db``, and purge deletes the
whole profile and refuses any path that is not directly under ``<home>/profiles``.
"""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from degram_variant import profiles
from degram_variant.profiles import (
    ProfilePathError,
    Scope,
    ensure_scope_profile,
    profile_name_for_scope,
    purge_scope_profile,
)

REPO = Path(__file__).resolve().parents[2]


def expected_name(user, company, project) -> str:
    digest = hashlib.sha256(f"{user}\x1f{company or ''}\x1f{project}".encode("utf-8")).hexdigest()
    return "scope-" + digest[:16]


@pytest.fixture
def home(tmp_path) -> Path:
    path = tmp_path / "DeGram" / "home"
    path.mkdir(parents=True)
    return path


# ── naming ───────────────────────────────────────────────────────────────────────────────────


class TestProfileName:
    def test_formula(self):
        assert profile_name_for_scope("alice", "acme", "tower") == expected_name("alice", "acme", "tower")
        assert profile_name_for_scope("alice", "acme", "tower").startswith("scope-")
        assert len(profile_name_for_scope("alice", "acme", "tower")) == len("scope-") + 16

    def test_company_none_is_encoded_as_empty(self):
        assert profile_name_for_scope("alice", None, "tower") == expected_name("alice", "", "tower")
        assert profile_name_for_scope("alice", None, "tower") == profile_name_for_scope("alice", "", "tower")

    def test_stable_and_distinct(self):
        names = {
            profile_name_for_scope(u, c, p)
            for u in ("alice", "bob") for c in (None, "acme", "globex") for p in ("tower", "bridge")}
        assert len(names) == 2 * 3 * 2
        assert profile_name_for_scope("alice", "acme", "tower") == profile_name_for_scope("alice", "acme", "tower")

    def test_field_boundaries_cannot_collide(self):
        assert profile_name_for_scope("a", "bc", "d") != profile_name_for_scope("ab", "c", "d")
        assert profile_name_for_scope("a", None, "bc") != profile_name_for_scope("ab", None, "c")

    @pytest.mark.parametrize("user,company,project", [
        ("", "acme", "tower"), ("alice", "acme", ""), (" ", None, "tower"), ("alice", None, None),
        ("al\x1fice", "acme", "tower"), ("alice", "ac\x1fme", "tower"), ("alice", "acme", "to\x1fwer")])
    def test_invalid_scope_is_refused(self, user, company, project):
        with pytest.raises(ValueError):
            profile_name_for_scope(user, company, project)


# ── ensure ───────────────────────────────────────────────────────────────────────────────────


def read_config(path: Path) -> dict:
    from utils import fast_safe_load

    return fast_safe_load(path.read_text(encoding="utf-8")) or {}


class TestEnsure:
    def test_creates_the_profile_directory_and_a_locked_config(self, home):
        result = ensure_scope_profile(home, Scope("alice", "acme", "tower"))
        path = Path(result["path"])
        assert result["profile"] == expected_name("alice", "acme", "tower")
        assert path == (home / "profiles" / result["profile"]).resolve()
        cfg = read_config(path / "config.yaml")
        assert cfg["model"]["provider"] == "custom" and cfg["model"]["default"] == "degram-system"
        assert cfg["fallback_providers"] == []
        assert cfg["model_catalog"]["enabled"] is False
        assert cfg["telemetry"]["shared_metrics"]["enabled"] is False and cfg["telemetry"]["shared_metrics"]["send"] is False
        assert cfg["updates"]["check"] is False and cfg["nous"]["guest"] is False
        # plan 11: the template carries the bundled-Python placeholders and is enabled; an unset variable keeps the
        # literal placeholder, the spawn fails and the Revit group reports setup-incomplete
        assert cfg["mcp_servers"]["revit"]["enabled"] is True
        assert cfg["mcp_servers"]["revit"]["command"] == "${DEGRAM_PYTHON}"
        assert cfg["mcp_servers"]["revit"]["sampling"]["enabled"] is False
        for task, block in cfg["auxiliary"].items():
            if isinstance(block, dict):
                assert block.get("provider", "auto") == "auto", task
                assert not block.get("base_url") and not block.get("api_key"), task

    def test_template_carries_no_secret_and_no_url(self, home):
        text = (Path(profiles.__file__).parent / "config_template.yaml").read_text(encoding="utf-8")
        generated = (Path(ensure_scope_profile(home, Scope("alice", None, "tower"))["path"]) / "config.yaml").read_text(
            encoding="utf-8")
        for blob in (text, generated):
            lowered = blob.lower()
            assert "http://" not in lowered and "https://" not in lowered, "the relay URL arrives with the credentials"
            assert "sk-" not in lowered and "dgd_" not in lowered and "bearer" not in lowered

    def test_user_edits_are_discarded_on_every_ensure(self, home):
        scope = Scope("alice", "acme", "tower")
        first = Path(ensure_scope_profile(home, scope)["path"]) / "config.yaml"
        original = first.read_text(encoding="utf-8")
        first.write_text("model:\n  provider: openrouter\nfallback_providers:\n  - provider: x\n", encoding="utf-8")
        ensure_scope_profile(home, scope)
        assert first.read_text(encoding="utf-8") == original

    def test_revit_command_from_settings_fills_the_placeholder(self, home):
        out = ensure_scope_profile(home, Scope("alice", "acme", "tower"),
                                   revit_command="C:\\DeGram\\revit-mcp.exe", revit_args=["--read-only"])
        revit = read_config(Path(out["path"]) / "config.yaml")["mcp_servers"]["revit"]
        assert revit["command"] == "C:\\DeGram\\revit-mcp.exe" and revit["args"] == ["--read-only"]
        assert revit["enabled"] is True and revit["sampling"]["enabled"] is False

    def test_ensure_never_touches_state_of_an_existing_profile(self, home):
        scope = Scope("alice", "acme", "tower")
        path = Path(ensure_scope_profile(home, scope)["path"])
        (path / "state.db").write_bytes(b"history")
        (path / "memories").mkdir()
        (path / "memories" / "note.md").write_text("n", encoding="utf-8")
        ensure_scope_profile(home, scope)
        assert (path / "state.db").read_bytes() == b"history" and (path / "memories" / "note.md").exists()

    def test_written_config_survives_the_degram_loader_unchanged(self, home, monkeypatch):
        """The profile config and ``lock_config`` agree: loading under variant degram changes nothing material."""
        path = Path(ensure_scope_profile(home, Scope("alice", "acme", "tower"))["path"])
        monkeypatch.setenv("HERMES_DEGRAM", "1")
        monkeypatch.setenv("HERMES_HOME", str(path))
        from hermes_cli.config import load_config
        cfg = load_config()
        written = read_config(path / "config.yaml")
        assert cfg["model"]["provider"] == written["model"]["provider"] == "custom"
        assert cfg["fallback_providers"] == [] and cfg["model_catalog"]["enabled"] is False
        assert cfg["toolsets"] == ["clarify", "todo", "degram", "mcp-revit"]


# ── isolation ────────────────────────────────────────────────────────────────────────────────


class TestIsolation:
    def test_two_scopes_have_separate_state_dbs(self, home):
        from hermes_state import SessionDB

        a = Path(ensure_scope_profile(home, Scope("alice", "acme", "tower"))["path"])
        b = Path(ensure_scope_profile(home, Scope("alice", "acme", "bridge"))["path"])
        assert a != b
        db_a, db_b = SessionDB(db_path=a / "state.db"), SessionDB(db_path=b / "state.db")
        try:
            db_a.create_session("only-in-a", source="cli")
            assert db_a.get_session("only-in-a") is not None
            assert db_b.get_session("only-in-a") is None
            assert not [s for s in db_b.list_sessions_rich(limit=50) if s.get("id") == "only-in-a"]
        finally:
            db_a.close()
            db_b.close()
        assert (a / "state.db").exists() and (b / "state.db").exists()
        assert (a / "state.db").read_bytes() != b"" and a / "state.db" != b / "state.db"


# ── purge ────────────────────────────────────────────────────────────────────────────────────


class TestPurge:
    def test_removes_the_whole_profile_and_only_that_one(self, home):
        keep = Path(ensure_scope_profile(home, Scope("alice", "acme", "bridge"))["path"])
        gone = Path(ensure_scope_profile(home, Scope("alice", "acme", "tower"))["path"])
        for sub in ("memories", "logs", "sessions"):
            (gone / sub).mkdir()
            (gone / sub / "x.txt").write_text("secret history", encoding="utf-8")
        (gone / "state.db").write_bytes(b"history")
        result = purge_scope_profile(home, Scope("alice", "acme", "tower"))
        assert result["removed"] is True and result["path"] == str(gone.resolve())
        assert not gone.exists()
        assert keep.exists() and (keep / "config.yaml").exists()

    def test_is_idempotent(self, home):
        scope = Scope("alice", "acme", "tower")
        ensure_scope_profile(home, scope)
        assert purge_scope_profile(home, scope)["removed"] is True
        assert purge_scope_profile(home, scope)["removed"] is False

    def test_removes_read_only_files(self, home):
        scope = Scope("alice", "acme", "tower")
        path = Path(ensure_scope_profile(home, scope)["path"])
        locked = path / "logs"
        locked.mkdir()
        (locked / "agent.log").write_text("x", encoding="utf-8")
        os.chmod(locked / "agent.log", 0o444)
        assert purge_scope_profile(home, scope)["removed"] is True
        assert not path.exists()

    @pytest.mark.parametrize("name", ["..", "../escape", "a/b", "a\\b", "", ".", "scope-x/../../y"])
    def test_path_safety_refuses_names_that_leave_profiles(self, home, name):
        with pytest.raises(ProfilePathError):
            profiles.profile_path(home, name)

    def test_profile_path_is_directly_under_home_profiles(self, home):
        path = profiles.profile_path(home, profile_name_for_scope("alice", "acme", "tower"))
        assert path.parent == (home / "profiles").resolve()

    def test_refuses_a_profile_that_resolves_outside_home_profiles(self, home, tmp_path):
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "keep.txt").write_text("precious", encoding="utf-8")
        (home / "profiles").mkdir()
        name = profile_name_for_scope("alice", "acme", "tower")
        link = home / "profiles" / name
        try:
            os.symlink(outside, link, target_is_directory=True)
        except (OSError, NotImplementedError):
            if os.name != "nt":
                pytest.skip("symlinks are not available here")
            # no symlink privilege: a directory junction is the same escape and needs none
            made = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True, text=True)
            if made.returncode != 0:
                pytest.skip("neither symlinks nor junctions are available here")
        with pytest.raises(ProfilePathError):
            purge_scope_profile(home, Scope("alice", "acme", "tower"))
        assert (outside / "keep.txt").exists()


# ── CLI ──────────────────────────────────────────────────────────────────────────────────────


def run_cli(*args: str):
    env = {k: v for k, v in os.environ.items() if not k.startswith("HERMES_")}
    env["PYTHONPATH"] = str(REPO)
    env["PYTHONUTF8"] = "1"
    return subprocess.run([sys.executable, "-m", "degram_variant.profiles", *args], cwd=str(REPO), env=env,
                          capture_output=True, text=True, timeout=120)


class TestCli:
    def test_ensure_then_purge_print_json(self, home):
        base = ["--home", str(home), "--user", "alice", "--company", "acme", "--project", "tower"]
        ensured = run_cli("ensure", *base)
        assert ensured.returncode == 0, ensured.stderr
        payload = json.loads(ensured.stdout.strip().splitlines()[-1])
        assert payload["profile"] == expected_name("alice", "acme", "tower")
        assert Path(payload["path"]) == (home / "profiles" / payload["profile"]).resolve()
        assert (Path(payload["path"]) / "config.yaml").exists()
        purged = run_cli("purge", *base)
        assert purged.returncode == 0, purged.stderr
        out = json.loads(purged.stdout.strip().splitlines()[-1])
        assert out["profile"] == payload["profile"] and out["removed"] is True
        assert not Path(payload["path"]).exists()

    def test_company_is_optional(self, home):
        done = run_cli("ensure", "--home", str(home), "--user", "alice", "--project", "tower")
        assert done.returncode == 0, done.stderr
        assert json.loads(done.stdout.strip().splitlines()[-1])["profile"] == expected_name("alice", None, "tower")

    def test_bad_input_exits_non_zero_without_creating_anything(self, home):
        done = run_cli("ensure", "--home", str(home), "--user", "", "--project", "tower")
        assert done.returncode != 0
        assert not (home / "profiles").exists()
        assert run_cli("ensure", "--home", str(home)).returncode == 2  # argparse: missing required args
        assert run_cli("explode", "--home", str(home), "--user", "a", "--project", "p").returncode == 2

    def test_relative_home_is_refused(self):
        done = run_cli("ensure", "--home", "relative/home", "--user", "alice", "--project", "tower")
        assert done.returncode != 0


# -- scope manifests, purge by project, legacy cleanup (plan 1301-20, G-15, D-30) ----------------


def manifest_of(path: Path) -> dict:
    return json.loads((Path(path) / "degram-scope.json").read_text(encoding="utf-8"))


class TestManifest:
    def test_ensure_writes_the_manifest_with_fixed_fields_and_no_token(self, home):
        path = Path(ensure_scope_profile(home, Scope("alice", "acme", "tower"))["path"])
        data = manifest_of(path)
        assert set(data) == {"user", "company", "project", "createdAt"}
        assert (data["user"], data["company"], data["project"]) == ("alice", "acme", "tower")
        assert data["createdAt"].endswith("Z")
        blob = (path / "degram-scope.json").read_text(encoding="utf-8").lower()
        assert "dgd_" not in blob and "token" not in blob and "sk-" not in blob and "bearer" not in blob
        assert not list(path.glob("degram-scope.json.*")), "no temp file is left behind"

    def test_company_none_is_stored_as_null(self, home):
        path = Path(ensure_scope_profile(home, Scope("alice", None, "tower"))["path"])
        assert manifest_of(path)["company"] is None

    def test_ensure_keeps_created_at_of_the_same_scope(self, home):
        scope = Scope("alice", "acme", "tower")
        path = Path(ensure_scope_profile(home, scope)["path"])
        (path / "degram-scope.json").write_text(
            json.dumps({"user": "alice", "company": "acme", "project": "tower", "createdAt": "2020-01-01T00:00:00Z"}),
            encoding="utf-8")
        ensure_scope_profile(home, scope)
        assert manifest_of(path)["createdAt"] == "2020-01-01T00:00:00Z"

    def test_ensure_backfills_a_legacy_profile_without_touching_its_state(self, home):
        scope = Scope("alice", "acme", "tower")
        legacy = home / "profiles" / profile_name_for_scope(*scope)
        legacy.mkdir(parents=True)
        (legacy / "state.db").write_bytes(b"old history")
        ensure_scope_profile(home, scope)
        assert manifest_of(legacy)["project"] == "tower"
        assert (legacy / "state.db").read_bytes() == b"old history"


class TestPurgeProject:
    def test_removes_every_company_key_of_that_user_and_project_only(self, home):
        under_none = Path(ensure_scope_profile(home, Scope("alice", None, "tower"))["path"])
        under_acme = Path(ensure_scope_profile(home, Scope("alice", "acme", "tower"))["path"])
        under_globex = Path(ensure_scope_profile(home, Scope("alice", "globex", "tower"))["path"])
        other_project = Path(ensure_scope_profile(home, Scope("alice", "acme", "bridge"))["path"])
        other_user = Path(ensure_scope_profile(home, Scope("bob", "acme", "tower"))["path"])
        for path in (under_none, under_acme, under_globex):
            (path / "state.db").write_bytes(b"history")
        removed = profiles.purge_project_profiles(home, "alice", "tower")
        assert sorted(removed) == sorted([under_none.name, under_acme.name, under_globex.name])
        assert not any(p.exists() for p in (under_none, under_acme, under_globex))
        assert other_project.exists() and other_user.exists()

    def test_is_idempotent_and_ignores_a_missing_profiles_root(self, home):
        assert profiles.purge_project_profiles(home, "alice", "tower") == []
        ensure_scope_profile(home, Scope("alice", "acme", "tower"))
        assert len(profiles.purge_project_profiles(home, "alice", "tower")) == 1
        assert profiles.purge_project_profiles(home, "alice", "tower") == []

    def test_leaves_profiles_without_a_manifest_alone(self, home):
        legacy = home / "profiles" / "scope-0123456789abcdef"
        legacy.mkdir(parents=True)
        assert profiles.purge_project_profiles(home, "alice", "tower") == []
        assert legacy.exists()

    def test_a_malformed_manifest_matches_nothing(self, home):
        path = Path(ensure_scope_profile(home, Scope("alice", "acme", "tower"))["path"])
        (path / "degram-scope.json").write_text("{not json", encoding="utf-8")
        assert profiles.purge_project_profiles(home, "alice", "tower") == []
        assert path.exists()

    def test_requires_user_and_project(self, home):
        with pytest.raises(ValueError):
            profiles.purge_project_profiles(home, "", "tower")
        with pytest.raises(ValueError):
            profiles.purge_project_profiles(home, "alice", " ")


class TestLegacyCleanup:
    def make_legacy(self, home, name):
        path = home / "profiles" / name
        path.mkdir(parents=True)
        (path / "state.db").write_bytes(b"old")
        return path

    def test_backfills_kept_scopes_removes_the_rest_once_and_writes_the_marker(self, home):
        keep_scope = Scope("alice", "acme", "tower")
        kept = self.make_legacy(home, profile_name_for_scope(*keep_scope))
        stale = self.make_legacy(home, profile_name_for_scope("alice", None, "tower"))  # opened before its company
        modern = Path(ensure_scope_profile(home, Scope("alice", "acme", "bridge"))["path"])
        result = profiles.cleanup_legacy_profiles(home, [keep_scope])
        assert result["ran"] is True and result["failed"] == []
        assert result["backfilled"] == [kept.name] and result["removed"] == [stale.name]
        assert kept.exists() and (kept / "state.db").read_bytes() == b"old"
        assert manifest_of(kept)["project"] == "tower"
        assert not stale.exists() and modern.exists()
        assert (home / "profiles" / "degram-legacy-cleanup.done").is_file()

    def test_the_second_run_does_nothing(self, home):
        profiles.cleanup_legacy_profiles(home, [])
        late = self.make_legacy(home, "scope-fedcba9876543210")
        again = profiles.cleanup_legacy_profiles(home, [])
        assert again == {"ran": False, "backfilled": [], "removed": [], "failed": []}
        assert late.exists()

    def test_a_fresh_install_still_writes_the_marker(self, home):
        assert profiles.cleanup_legacy_profiles(home, [])["ran"] is True
        assert (home / "profiles" / "degram-legacy-cleanup.done").is_file()

    def test_a_failed_removal_keeps_the_marker_unwritten(self, home, monkeypatch):
        self.make_legacy(home, "scope-0123456789abcdef")

        def boom(path, name):
            raise OSError("locked")

        monkeypatch.setattr(profiles, "_remove_tree", boom)
        result = profiles.cleanup_legacy_profiles(home, [])
        assert result["failed"] == ["scope-0123456789abcdef"]
        assert not (home / "profiles" / "degram-legacy-cleanup.done").exists()

    def test_non_scope_entries_are_never_removed(self, home):
        (home / "profiles").mkdir()
        (home / "profiles" / "default").mkdir()
        profiles.cleanup_legacy_profiles(home, [])
        assert (home / "profiles" / "default").exists()


class TestCliPlan20:
    def test_purge_project_and_cleanup_legacy_print_json(self, home):
        for company in ("acme", "globex"):
            assert run_cli("ensure", "--home", str(home), "--user", "alice", "--company", company,
                           "--project", "tower").returncode == 0
        done = run_cli("purge-project", "--home", str(home), "--user", "alice", "--project", "tower")
        assert done.returncode == 0, done.stderr
        assert sorted(json.loads(done.stdout.strip().splitlines()[-1])) == sorted(
            [expected_name("alice", "acme", "tower"), expected_name("alice", "globex", "tower")])
        keep = json.dumps([{"user": "alice", "company": "acme", "project": "tower"}])
        cleaned = run_cli("cleanup-legacy", "--home", str(home), f"--keep-json={keep}")
        assert cleaned.returncode == 0, cleaned.stderr
        assert json.loads(cleaned.stdout.strip().splitlines()[-1])["ran"] is True

    def test_cleanup_legacy_refuses_a_non_list(self, home):
        done = run_cli("cleanup-legacy", "--home", str(home), "--keep-json={}")
        assert done.returncode != 0
