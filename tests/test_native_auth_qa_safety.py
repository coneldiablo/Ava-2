"""Unit contracts for native-auth QA safety helpers (not live QA evidence)."""
import ast
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load_script(name):
    path = ROOT / "scripts" / name
    spec = importlib.util.spec_from_file_location(path.stem.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare = load_script("prepare-native-auth-qa.py")
runner = load_script("run-native-auth-qa.py")
bridge = load_script("run-module-bridge-qa.py")
twenty = load_script("run-twenty-auth-qa.py")


class NativeAuthQaSafetyUnitTests(unittest.TestCase):
    def test_safe_excerpt_redacts_bearer_url_and_known_environment_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "native.env").write_text(
                "POSTGRES_PASSWORD=db-pass\nUSER_AUTH_SECRET=auth-pass\nNORMAL=value\n"
            )
            (directory / "probe.log").write_text(
                "Bearer bearer-secret\nhttps://user:password@example.test/path\n"
                "db-pass auth-pass\n"
            )
            output = runner.safe_excerpt(directory, "probe")
        self.assertNotIn("bearer-secret", output)
        self.assertNotIn("user:password", output)
        self.assertNotIn("db-pass", output)
        self.assertNotIn("auth-pass", output)
        self.assertIn("Bearer [REDACTED]", output)
        self.assertIn("https://[REDACTED]@example.test/path", output)

    def test_foreign_manifest_path_is_rejected_before_any_docker_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "manifest.json"
            manifest.write_text(json.dumps({"qa_only": True}))
            with mock.patch.object(runner.subprocess, "check_output", side_effect=AssertionError("docker called")):
                with self.assertRaisesRegex(ValueError, "QA_DIRECTORY_REQUIRED"):
                    runner.run(manifest)

    def test_prepare_bootstrap_uses_tcp_pg_isready_and_runtime_roles_are_restricted(self):
        source = (ROOT / "scripts" / "prepare-native-auth-qa.py").read_text()
        tree = ast.parse(source)
        pg_calls = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == "run"
            and node.args and isinstance(node.args[0], ast.List)
            and any(isinstance(arg, ast.Constant) and arg.value == "pg_isready" for arg in node.args[0].elts)
        ]
        self.assertEqual(len(pg_calls), 1)
        args = [arg.value for arg in pg_calls[0].args[0].elts if isinstance(arg, ast.Constant)]
        self.assertEqual(args[args.index("-h") + 1], "127.0.0.1")
        role_sql = re.findall(r"CREATE ROLE \{[^;]+;", source)
        self.assertEqual(len(role_sql), 2)
        for statement in role_sql:
            self.assertIn("NOSUPERUSER", statement)
            self.assertIn("NOCREATEDB", statement)
            self.assertIn("NOCREATEROLE", statement)

    def test_bridge_rejects_non_qa_path_without_touching_docker(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "manifest.json"
            manifest.write_text(json.dumps({"qa_only": True}))
            with mock.patch.object(bridge.subprocess, "check_output", side_effect=AssertionError("docker called")):
                with self.assertRaisesRegex(ValueError, "QA_DIRECTORY_REQUIRED"):
                    bridge.run(manifest)

    def test_restart_is_an_explicit_qa_action_and_rejects_foreign_manifest(self):
        self.assertIn("restart", twenty.COMMANDS)
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "manifest.json"
            manifest.write_text(json.dumps({"qa_only": True}))
            with mock.patch.object(twenty.subprocess, "check_output", side_effect=AssertionError("docker called")):
                with self.assertRaisesRegex(ValueError, "QA_DIRECTORY_REQUIRED"):
                    twenty.run(manifest, "restart")


if __name__ == "__main__":
    unittest.main()
