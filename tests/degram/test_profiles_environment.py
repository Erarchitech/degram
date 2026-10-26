"""Real filesystem environment isolation and interrupted legacy adoption (1301-43)."""
import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest

from degram_variant import profiles as p

A = "http://localhost:8080"
B = "https://dg.example.test"


def scope(origin=A, company="acme"):
    return p.Scope("alice", company, "tower", origin, p.environment_id_for_origin(origin))


def claim(home):
    (home / p.OWNERSHIP_NAME).write_text(json.dumps({
        "version": 1, "origin": A, "partition": "persist:degram-dg", "stage": "claimed"
    }), encoding="utf-8")


def legacy(home, manifest=True):
    path = home / "profiles" / p._legacy_name("alice", "acme", "tower")
    path.mkdir(parents=True)
    if manifest:
        (path / p.MANIFEST_NAME).write_text(json.dumps({
            "user": "alice", "company": "acme", "project": "tower", "createdAt": "2020-01-01T00:00:00Z"
        }), encoding="utf-8")
    for name in ("state.db", "memories/note.md", "logs/agent.log", "documents/binding.json", "config.yaml"):
        file = path / name
        file.parent.mkdir(exist_ok=True)
        file.write_bytes(name.encode())
    return path


def snapshot(path):
    return {str(f.relative_to(path)): f.read_bytes() for f in path.rglob("*") if f.is_file()}


def test_identity_vector():
    canonical = "https://dg.example.test"
    expected_env = "dg-env-v1-" + hashlib.sha256(f"dg-env-v1:{canonical}".encode()).hexdigest()
    assert p.environment_id_for_origin("HTTPS://DG.EXAMPLE.TEST:443/") == expected_env
    expected_name = "scope-" + hashlib.sha256(
        f"dg-profile-v2\x1f{canonical}\x1falice\x1facme\x1ftower".encode()).hexdigest()[:32]
    assert p.profile_name_for_scope(*scope(B)) == expected_name
    assert p.profile_name_for_scope(*scope(A)) != expected_name


def test_one_home_a_b_a_and_environment_scoped_revoke(tmp_path):
    a = Path(p.ensure_scope_profile(tmp_path, scope(A))["path"])
    (a / "state.db").write_bytes(b"A history")
    (a / "binding.json").write_bytes(b"A native document")
    before = snapshot(a)
    for company in (None, "acme", "other"):
        b = Path(p.ensure_scope_profile(tmp_path, scope(B, company))["path"])
        (b / "state.db").write_bytes(b"B history")
    assert p.cleanup_legacy_profiles(tmp_path, origin=B, environment_id=scope(B).environment_id)["removed"] == []
    assert len(p.purge_project_profiles(tmp_path, "alice", "tower", origin=B,
                                       environment_id=scope(B).environment_id)) == 3
    assert snapshot(a) == before
    assert Path(p.ensure_scope_profile(tmp_path, scope(A))["path"]) == a
    assert snapshot(a) == before


def test_actual_profiles_cli_uses_one_home_for_equal_ids_across_a_b_a(tmp_path):
    child_root = Path(__file__).resolve().parents[2]
    interpreter = os.environ.get("PYTHON", "python")
    available = subprocess.run([interpreter, "-c", "import ruamel.yaml"], cwd=child_root,
                               capture_output=True, text=True, check=False)
    if available.returncode:
        pytest.skip("real profiles CLI requires the already-installed locked ruamel.yaml payload")

    def ensure(origin, mode):
        environment = p.environment_id_for_origin(origin)
        command = [
            interpreter, "-m", "degram_variant.profiles", "ensure", f"--home={tmp_path}",
            "--user=alice", "--company=acme", "--project=tower", f"--origin={origin}",
            f"--environment-id={environment}",
        ]
        result = subprocess.run(command, cwd=child_root, env={**os.environ, "HERMES_HOME": str(tmp_path)},
                                capture_output=True, text=True, check=False)
        assert result.returncode == 0, result.stderr
        return Path(json.loads(result.stdout)["path"])

    a = ensure(A, "developer")
    (a / "state.db").write_bytes(b"local-A-cookie-history")
    b = ensure(B, "demo")
    (b / "state.db").write_bytes(b"remote-B-cookie-history")
    restored_a = ensure(A, "developer")

    assert a == restored_a and a != b
    assert (a / "state.db").read_bytes() == b"local-A-cookie-history"
    assert (b / "state.db").read_bytes() == b"remote-B-cookie-history"
    assert p._read_manifest(a)["origin"] == A
    assert p._read_manifest(b)["origin"] == B


@pytest.mark.parametrize("manifest", [False, True])
def test_local_adoption_preserves_history_config_and_bindings(tmp_path, manifest):
    claim(tmp_path)
    old = legacy(tmp_path, manifest)
    before = snapshot(old)
    result = p.migrate_legacy_profiles(tmp_path, [scope(A)], backend_stopped=True)
    target = tmp_path / "profiles" / p.profile_name_for_scope(*scope(A))
    assert result["reported"] == [] and not old.exists()
    for name, blob in before.items():
        if name != p.MANIFEST_NAME:
            assert (target / name).read_bytes() == blob
    assert p._read_manifest(target)["origin"] == A
    journal = json.loads((tmp_path / p.MIGRATION_NAME).read_text())
    assert journal["entries"][old.name]["stage"] == "complete"
    before = snapshot(target)
    p.migrate_legacy_profiles(tmp_path, [scope(A)], backend_stopped=True)
    assert snapshot(target) == before


def test_interruption_after_move_resumes_without_losing_state(tmp_path, monkeypatch):
    claim(tmp_path)
    old = legacy(tmp_path)
    with monkeypatch.context() as patch:
        patch.setattr(p, "_write_manifest", lambda *a, **k: (_ for _ in ()).throw(OSError("interrupted")))
        with pytest.raises(OSError):
            p.migrate_legacy_profiles(tmp_path, backend_stopped=True)
    assert not old.exists()
    assert len(p.migration_candidates(tmp_path)) == 2
    p.migrate_legacy_profiles(tmp_path, backend_stopped=True)
    target = tmp_path / "profiles" / p.profile_name_for_scope(*scope(A))
    assert (target / "state.db").read_bytes() == b"state.db"
    assert p._read_manifest(target)["origin"] == A


@pytest.mark.parametrize("manifest", ["{broken", json.dumps({"user": "mallory", "company": "acme", "project": "tower"})])
def test_interrupted_destination_with_conflicting_metadata_is_not_overwritten(tmp_path, monkeypatch, manifest):
    claim(tmp_path)
    legacy(tmp_path)
    with monkeypatch.context() as patch:
        patch.setattr(p, "_write_manifest", lambda *a, **k: (_ for _ in ()).throw(OSError("interrupted")))
        with pytest.raises(OSError):
            p.migrate_legacy_profiles(tmp_path, backend_stopped=True)
    target = tmp_path / "profiles" / p.profile_name_for_scope(*scope(A))
    (target / p.MANIFEST_NAME).write_text(manifest, encoding="utf-8")
    before = snapshot(tmp_path)
    with pytest.raises(ValueError, match="malformed"):
        p.migrate_legacy_profiles(tmp_path, backend_stopped=True)
    assert snapshot(tmp_path) == before


def test_incomplete_v2_manifest_is_not_legacy_ownership(tmp_path):
    claim(tmp_path)
    old = legacy(tmp_path)
    manifest = json.loads((old / p.MANIFEST_NAME).read_text())
    manifest["version"] = 2
    (old / p.MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
    before = snapshot(tmp_path)
    assert p.migrate_legacy_profiles(tmp_path, [scope(A)], backend_stopped=True)["reported"] == [old.name]
    assert snapshot(tmp_path) == before


def test_collision_preserves_both_and_ensure_refuses_history_shadow(tmp_path):
    claim(tmp_path)
    target = Path(p.ensure_scope_profile(tmp_path, scope(A))["path"])
    old = legacy(tmp_path)
    before = snapshot(tmp_path)
    assert p.migrate_legacy_profiles(tmp_path, backend_stopped=True)["reported"] == [old.name]
    assert snapshot(tmp_path) == before
    with pytest.raises(ValueError, match="migration"):
        p.ensure_scope_profile(tmp_path, scope(A))
    assert target.exists()


def test_unknown_origin_or_malformed_manifest_is_reported_not_deleted(tmp_path):
    old = legacy(tmp_path)
    before = snapshot(old)
    assert p.migrate_legacy_profiles(tmp_path)["reported"] == [old.name]
    assert snapshot(old) == before
    claim(tmp_path)
    (old / p.MANIFEST_NAME).write_text("{broken", encoding="utf-8")
    before = snapshot(old)
    assert p.migrate_legacy_profiles(tmp_path, backend_stopped=True)["reported"] == [old.name]
    p.cleanup_legacy_profiles(tmp_path, origin=B, environment_id=scope(B).environment_id)
    assert snapshot(old) == before


def test_no_unowned_destructive_default_or_conflicting_environment(tmp_path):
    with pytest.raises(ValueError, match="ownership"):
        p.purge_project_profiles(tmp_path, "alice", "tower")
    with pytest.raises(ValueError):
        p.ensure_scope_profile(tmp_path, p.Scope("alice", "acme", "tower", B, scope(A).environment_id))
    claim(tmp_path)
    legacy(tmp_path)
    with pytest.raises(ValueError, match="stopped"):
        p.migrate_legacy_profiles(tmp_path)


@pytest.mark.parametrize("origin", ["http://remote.test", "https://x/path", "https://u:p@x", "https://x?", "https://x#", "https://x\\evil"])
def test_origin_injection_is_rejected(origin):
    with pytest.raises(ValueError):
        p.environment_id_for_origin(origin)


def test_migration_and_cleanup_do_not_follow_legacy_directory_link(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    claim(home)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "state.db").write_bytes(b"unrelated history")
    root = home / "profiles"
    root.mkdir()
    link = root / p._legacy_name("alice", "acme", "tower")
    try:
        os.symlink(outside, link, target_is_directory=True)
    except (OSError, NotImplementedError):
        if os.name != "nt":
            pytest.skip("symlinks unavailable")
        made = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True)
        if made.returncode:
            pytest.skip("symlinks and junctions unavailable")
    before = snapshot(outside)
    assert p.migrate_legacy_profiles(home, [scope(A)], backend_stopped=True)["migrated"] == []
    p.cleanup_legacy_profiles(home, origin=A, environment_id=scope(A).environment_id)
    assert snapshot(outside) == before
    assert link.exists()


def test_tampered_journal_path_is_refused(tmp_path):
    claim(tmp_path)
    old = legacy(tmp_path)
    (tmp_path / p.MIGRATION_NAME).write_text(json.dumps({"version": 1, "origin": A, "entries": {
        old.name: {"destination": "../outside", "stage": "pending", "scope": {
            "user": "alice", "company": "acme", "project": "tower", "origin": A,
            "environmentId": scope(A).environment_id}}
    }}), encoding="utf-8")
    before = snapshot(old)
    with pytest.raises(ValueError):
        p.migrate_legacy_profiles(tmp_path, backend_stopped=True)
    assert snapshot(old) == before
