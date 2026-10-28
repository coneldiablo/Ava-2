import importlib.util
from pathlib import Path
import sqlite3
import json
import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import copy
import contextlib
import io
from urllib.error import URLError

spec = importlib.util.spec_from_file_location("voice_release", Path(__file__).with_name("release_operator.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class BackupTests(unittest.TestCase):
    def test_readonly_backup_copies_schema_and_actual_rows_with_escaped_path(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / "source with spaces.db", root / "backup.db"
            with sqlite3.connect(source) as db:
                db.executescript("CREATE TABLE preserved (value INTEGER); INSERT INTO preserved VALUES (42);")
            result = release.backup(source, target)
            with sqlite3.connect(target) as db:
                self.assertEqual(db.execute("SELECT value FROM preserved").fetchall(), [(42,)])
            self.assertEqual(result["verifiedTables"], 1)
            self.assertFalse((root / "source with spaces.db?mode=ro").exists())

    def test_missing_source_is_not_created(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "missing.db"
            with self.assertRaises(sqlite3.OperationalError):
                release.backup(source, Path(folder) / "backup.db")
            self.assertFalse(source.exists())

    def test_previous_backup_is_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "backup.db"
            target.write_bytes(b"preserved")
            with self.assertRaisesRegex(RuntimeError, "BACKUP_EXISTS"):
                release.backup(Path(folder) / "source.db", target)
            self.assertEqual(target.read_bytes(), b"preserved")

    def test_actual_vec0_virtual_schema_is_copied_without_virtual_select(self):
        modules = os.environ.get("AVA_RELEASE_NODE_MODULES")
        if not modules:
            self.skipTest("Set AVA_RELEASE_NODE_MODULES for real sqlite-vec fixture")
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "vectors.db"
            code = "const Database=require(" + json.dumps(modules + "/better-sqlite3") + ");const vec=require(" + json.dumps(modules + "/sqlite-vec") + ");const db=new Database(process.argv[1]);vec.load(db);db.exec('CREATE TABLE preserved(value INTEGER);INSERT INTO preserved VALUES(42);CREATE VIRTUAL TABLE kb_chunks_vec USING vec0(embedding float[3]);');db.close();"
            subprocess.run(["node", "-e", code, str(source)], check=True, capture_output=True, text=True, timeout=10)
            target = Path(folder) / "backup.db"
            release.backup(source, target)
            with sqlite3.connect(target) as db:
                self.assertEqual(db.execute("SELECT value FROM preserved").fetchall(), [(42,)])
                self.assertIsNotNone(db.execute("SELECT sql FROM sqlite_master WHERE name='kb_chunks_vec'").fetchone())


class MountFenceTests(unittest.TestCase):
    def test_different_source_with_same_count_is_rejected_by_signature(self):
        live = [{"Type": "bind", "Source": "/live/data", "Destination": "/app/data", "RW": True, "Propagation": "rprivate"}]
        disk = [{"type": "bind", "source": "/wrong/data", "target": "/app/data"}]
        self.assertNotEqual(release.mount_signature(live, live=True), release.mount_signature(disk))

    def test_readonly_change_is_not_ignored(self):
        left = [{"type": "bind", "source": "/live/data", "target": "/app/data", "read_only": False}]
        right = [{**left[0], "read_only": True}]
        self.assertNotEqual(release.mount_signature(left), release.mount_signature(right))


class TransitionTests(unittest.TestCase):
    def test_engine_up_waits_for_listener_ari_audio_and_provider_readiness(self):
        p = {"inputs": {}, "before": {"engine": {}}, "intended": {"engine": {"image": "new"}}}
        ready = {"status": "healthy", "ari_connected": True, "audiosocket": {"listening": True},
                 "providers": {"neuro_gemini": {"ready": True}}}
        def response(value):
            return contextlib.closing(io.BytesIO(json.dumps(value).encode()))
        sequence = [URLError("startup"), response({"status": "starting"}),
                    response({**ready, "providers": {}}), response(ready)]
        with patch.object(release, "rendered", return_value=p["intended"]["engine"]), patch.object(release, "compose", return_value=(["compose"], "/", "engine")), patch.object(release, "run"), patch.object(release, "inspect", return_value={"State": {"Running": True}, "RestartCount": 0}), patch.object(release, "check_container"), patch.object(release.time, "sleep"), patch.object(release, "urlopen", side_effect=sequence) as health:
            release.up(p, "engine", Path("override"))
            self.assertEqual(health.call_count, 4)

    def test_engine_listener_failure_is_bounded_even_when_process_runs(self):
        p = {"inputs": {}, "before": {"engine": {}}, "intended": {"engine": {"image": "new"}}}
        with patch.object(release, "rendered", return_value=p["intended"]["engine"]), patch.object(release, "compose", return_value=(["compose"], "/", "engine")), patch.object(release, "run"), patch.object(release, "inspect", return_value={"State": {"Running": True}, "RestartCount": 0}), patch.object(release, "check_container"), patch.object(release.time, "sleep"), patch.object(release.time, "monotonic", side_effect=[0, 1, 50, 101]), patch.object(release, "urlopen", side_effect=URLError("not ready")):
            with self.assertRaisesRegex(RuntimeError, "SERVICE_HEALTH_TIMEOUT"):
                release.up(p, "engine", Path("override"))

    def test_migration_requires_actual_probe_success_contract(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "tooling").mkdir()
            (root / "tooling/migration_probe.cjs").write_text("// probe")
            database = root / "crm.db"
            database.write_bytes(b"fixture")
            stat = database.stat()
            p = {"database": str(database), "images": {"crm": "candidate"},
                 "databaseMetadata": [stat.st_uid, stat.st_gid, stat.st_mode & 0o777]}
            success = {"ok": True, "mode": "apply", "initVerified": True,
                       "voiceColumnsVerified": True, "exactDataFence": False}
            with patch.object(release, "run", return_value=json.dumps(success)):
                release.migrate_live(root, p)
            for invalid in ({**success, "mode": "migrate"}, {**success, "voiceColumnsVerified": False}, {"pass": True}):
                with patch.object(release, "run", return_value=json.dumps(invalid)):
                    with self.assertRaisesRegex(RuntimeError, "LIVE_MIGRATION_FAILED"):
                        release.migrate_live(root, p)

    def test_complete_and_partial_staging_retry_preserve_canonical_intent(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            p = {"before": {}, "intended": {}, "overrides": {}}
            for role in release.NAMES:
                p["before"][role] = {"Config": {"Labels": {"com.docker.compose.service": role}}}
                p["intended"][role] = {"image": "candidate", "environment": {"NEURO_GEMINI_ENABLED": "true"}, "volumes": []}
                p["overrides"][role] = str(root / (role + ".candidate.json"))
            failed = [False]
            def render(row, override):
                role = row["Config"]["Labels"]["com.docker.compose.service"]
                if role == "worker" and not failed[0]:
                    failed[0] = True
                    raise RuntimeError("SYNTHETIC_RENDER_FAILURE")
                return json.loads(Path(override).read_text())["services"][role]
            with patch.object(release, "rendered", side_effect=render):
                with self.assertRaisesRegex(RuntimeError, "SYNTHETIC_RENDER_FAILURE"):
                    release.stage_admission(root, p)
                p = release.load(root)
                release.stage_admission(root, p)
                release.stage_admission(root, p)
            for role in ("crm", "worker"):
                for field, expected in (("activationOverrides", "true"), ("overrides", "false")):
                    actual = json.loads(Path(p[field][role]).read_text())["services"][role]
                    self.assertEqual(actual["environment"]["NEURO_GEMINI_ENABLED"], expected)

    def test_tampered_staged_config_is_rejected_before_writing_live(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            live, staged = root / "live.yaml", root / "staged.yaml"
            live.write_text("original")
            staged.write_text("candidate")
            p = {"liveConfig": str(live), "stagedConfig": str(staged),
                 "configBeforeHash": release.sha(live), "configAfterHash": release.sha(staged)}
            staged.write_text("tampered")
            with self.assertRaisesRegex(RuntimeError, "REPLACEMENT_CONFIG_DRIFT"):
                release.replace_config(p, staged, p["configBeforeHash"])
            self.assertEqual(live.read_text(), "original")

    def test_stale_provider_success_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            p = {"sourceCommit": "source", "images": {"engine": "engine", "crm": "crm"}}
            (root / "migration-gate.json").write_text(json.dumps({"pass": True, "sourceCommit": "source", "candidateImage": "crm"}))
            (root / "runtime-smoke.json").write_text(json.dumps({"pass": True, "sourceCommit": "foreign", "image": "foreign"}))
            with patch.object(release, "load", return_value=p), patch.object(release, "guard_original"), patch.object(release, "idle") as idle:
                with self.assertRaisesRegex(RuntimeError, "PROVIDER_SMOKE_MISSING"):
                    release.apply(root)
                idle.assert_not_called()

    def test_rollback_never_recreates_during_active_call_or_after_activation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with patch.object(release, "load", return_value={}), patch.object(release, "idle", side_effect=RuntimeError("ACTIVE_CALLS")), patch.object(release, "up") as up:
                with self.assertRaisesRegex(RuntimeError, "ACTIVE_CALLS"):
                    release.rollback(root)
                up.assert_not_called()
                (root / "activation-started.private.json").write_text("{}")
                with self.assertRaisesRegex(RuntimeError, "ACTIVATED_RELEASE_REQUIRES_COMPATIBILITY_RECOVERY"):
                    release.rollback(root)
                up.assert_not_called()

    def test_partial_activation_closes_admission_and_retry_completes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "applied.private.json").write_text("{}")
            p = {"sourceCommit": "source", "activationOverrides": {r: r + "active" for r in ("crm", "worker")},
                 "overrides": {r: r + "closed" for r in ("crm", "worker")}}
            states, fail = {"crm": False, "worker": False}, [True]
            def up(p, role, override, active=False):
                states[role] = active
                if role == "crm" and active and fail[0]:
                    fail[0] = False
                    raise RuntimeError("SERVICE_HEALTH_TIMEOUT")
            def verify(root, active=False):
                self.assertEqual(states, {"crm": active, "worker": active})
                return {"sourceCommit": "source", "newSelectionEnabled": active}
            with patch.object(release, "load", return_value=p), patch.object(release, "idle"), patch.object(release, "up", side_effect=up), patch.object(release, "verify", side_effect=verify):
                with self.assertRaisesRegex(RuntimeError, "ACTIVATION_FAILED_ADMISSION_CLOSED_CANDIDATE_RETAINED"):
                    release.activate(root)
                self.assertEqual(states, {"crm": False, "worker": False})
                self.assertTrue((root / "activation-started.private.json").exists())
                with contextlib.redirect_stdout(io.StringIO()):
                    release.activate(root)
                self.assertTrue((root / "activated.private.json").is_file())
                self.assertEqual(states, {"crm": True, "worker": True})


if __name__ == "__main__":
    unittest.main()
