"""Contract tests for the disposable Onyx document QA wrapper.

All calls are mocked; these tests do not run Docker or establish native acceptance.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location(
    "run_onyx_document_qa", ROOT / "scripts/run-onyx-document-qa.py"
)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class OnyxDocumentRunnerSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.deployment_id = str(uuid.uuid4())
        self.run_id = str(uuid.uuid4())
        self.namespace = "ava_" + self.deployment_id.replace("-", "")

    def _success_payload(self) -> dict:
        evidence_keys = {
            "provisioned", "session_created", "upload_status_ok", "file_indexed_completed",
            "opensearch_indexed", "foreign_scope_provision_denied", "unknown_binding_read_denied",
            "unknown_binding_delete_denied", "cross_scope_opensearch_denied", "file_deleted",
            "opensearch_purged", "session_revoked", "session_revoke_idempotent", "user_disabled",
            "late_session_denied", "late_provision_denied", "cleaned_up",
        }
        probe = ROOT / "native_modules/onyx/auth/qa_documents_peer.py"
        helper = ROOT / "native_modules/onyx/auth/qa_documents.py"
        sources = runner._source_hashes(probe, helper)
        return {
            "ok": True,
            "qa_only": True,
            "buyer_acceptance": False,
            "rag_acceptance": False,
            "schema_version": 3,
            "run_id": self.run_id,
            "started_at_ms": 100_000,
            "completed_at_ms": 100_500,
            "business_id": 911001,
            "deployment_id": self.deployment_id,
            "namespace": self.namespace,
            **sources,
            "transport": "running_auth_peer_and_native_http",
            "deletion": "native_endpoint_and_worker_observed",
            "file_scope_negative": "unknown_binding_guard_only",
            "evidence": {key: True for key in evidence_keys},
        }

    def test_accepts_only_complete_bounded_success_contract(self) -> None:
        payload = self._success_payload()
        self.assertEqual(runner.safe_probe_result(json.dumps(payload)), payload)

    def test_rejects_success_with_extra_secret_or_unknown_fields(self) -> None:
        payload = self._success_payload()
        payload["password"] = "must-not-escape"
        with self.assertRaisesRegex(ValueError, "QA_RESULT_CONTRACT_INVALID"):
            runner.safe_probe_result(json.dumps(payload))

    def test_rejects_wrong_evidence_and_transport_contracts(self) -> None:
        payload = self._success_payload()
        payload["evidence"]["file_deleted"] = False
        with self.assertRaisesRegex(ValueError, "QA_RESULT_CHECKS_INVALID"):
            runner.safe_probe_result(json.dumps(payload))

        payload = self._success_payload()
        payload["transport"] = "mock_http"
        with self.assertRaisesRegex(ValueError, "QA_RESULT_TRANSPORT_INVALID"):
            runner.safe_probe_result(json.dumps(payload))

    def test_failure_result_discards_raw_secrets_and_only_keeps_safe_frames(self) -> None:
        secret = "postgres://admin:should-never-leak@10.0.0.4/db"
        raw = json.dumps({
            "ok": False,
            "error_type": "RuntimeError",
            "error": secret,
            "locals": {"token": "secret-token"},
            "frames": [
                {"file": "safe_module.py", "function": "probe", "line": 42},
                {"file": secret, "function": "probe", "line": 43},
                {"file": "bad.py", "function": "probe", "line": True},
            ],
        })
        safe = runner.safe_probe_result(raw)
        encoded = json.dumps(safe)
        self.assertEqual(safe["error_type"], "RuntimeError")
        self.assertEqual(safe["frames"], [{"file": "safe_module.py", "function": "probe", "line": 42}])
        self.assertNotIn("should-never-leak", encoded)
        self.assertNotIn("secret-token", encoded)
        self.assertNotIn("10.0.0.4", encoded)

    def test_rejects_oversized_output_and_missing_result(self) -> None:
        with self.assertRaisesRegex(ValueError, "QA_OUTPUT_LIMIT"):
            runner.safe_probe_result("x" * 2_000_001)
        with self.assertRaisesRegex(ValueError, "QA_RESULT_MISSING"):
            runner.safe_probe_result("startup log only")

    def test_run_rejects_success_payload_bound_to_another_deployment(self) -> None:
        with tempfile.TemporaryDirectory(prefix="onyx-doc-runner-test-") as temporary:
            directory = Path(temporary)
            deployment = self.deployment_id
            row = {
                "id": deployment,
                "businessId": 911001,
                "module": "onyx",
                "revision": 1,
                "hostname": "qa.knowledge.invalid",
                "namespace": self.namespace,
                "sourceCommit": runner.qa.helper.PINNED["onyx"],
                "reservedMemoryMiB": 12800,
            }
            manifest = {"row": row}
            root = directory / "recipe"
            config = root / "config"
            config.mkdir(parents=True)
            auth_mounts = []
            api_mounts = []
            for name, target, destination in (
                ("gateway.key", "/run/ava-keys/gateway.key", auth_mounts),
                ("worker.key", "/run/ava-keys/worker.key", auth_mounts),
                ("ca.pem", "/run/ava-search-ca/ca.pem", api_mounts),
            ):
                source = config / name
                source.write_text("test")
                destination.append({"Destination": target, "Type": "bind", "RW": False, "Source": str(source)})

            (config / "native.env").write_text("\n".join((
                "AVA_BUSINESS_ID=911001", f"AVA_DEPLOYMENT_ID={deployment}",
                f"AVA_DEPLOYMENT_NAMESPACE={self.namespace}", "AVA_DEPLOYMENT_REVISION=1",
                f"OPENSEARCH_ADMIN_USERNAME={self.namespace}_runtime",
                "OPENSEARCH_ADMIN_PASSWORD=" + "p" * 43,
                "OPENSEARCH_VERIFY_CERTS=true", "OPENSEARCH_CA_CERTS=/run/ava-search-ca/ca.pem",
            )) + "\n")

            api = {
                "State": {"Health": {"Status": "healthy"}},
                "Mounts": api_mounts,
                "Image": "sha256:" + "c" * 64,
            }
            containers = {name: {} for name in ("worker", "web", "inference_model", "indexing_model")}
            containers["api"] = api
            containers["auth"] = {"State": {"Health": {"Status": "healthy"}},
                                  "Mounts": auth_mounts, "Image": api["Image"]}
            launcher = mock.Mock()
            launcher._recipe.return_value = (root, {"composeSha256": "a" * 64}, {})
            valid = self._success_payload()
            valid["deployment_id"] = str(uuid.uuid4())
            execution = mock.Mock(returncode=0, stdout=json.dumps(valid))

            with mock.patch.object(runner.qa, "_scope", return_value=directory), \
                 mock.patch.object(runner.qa, "_load_manifest", return_value=manifest), \
                 mock.patch.object(runner.qa.helper, "Deployments", return_value=launcher), \
                 mock.patch.object(runner.qa, "_containers", return_value=containers), \
                 mock.patch.object(runner.qa, "_runtime_mounts_private", return_value=True), \
                 mock.patch.object(runner.qa.helper, "owned_path", side_effect=lambda path, **_: Path(path)), \
                 mock.patch.object(runner.qa.helper, "run", return_value='[{"Internal": true}]'), \
                 mock.patch.object(runner.subprocess, "run", return_value=execution) as execute, \
                 mock.patch.object(runner.Path, "read_text", return_value="MemTotal: 10000000 kB\nMemAvailable: 9000000 kB\n"), \
                 mock.patch.object(runner.time, "time", side_effect=(100.0, 101.0)), \
                 mock.patch.object(runner.qa, "_private_new"):
                with self.assertRaisesRegex(ValueError, "QA_RESULT_BINDING_INVALID"):
                    runner.run(directory)
            command = execute.call_args.args[0]
            serialized = json.dumps(command)
            self.assertNotIn("/var/lib/ava-auth", serialized)
            self.assertNotIn("state.key", serialized)
            self.assertNotIn("native.env", serialized)
            self.assertNotIn("OPENSEARCH_ADMIN_PASSWORD", serialized)
            self.assertIn("/run/ava-peer/gateway.key", serialized)
            self.assertIn("/run/ava-peer/worker.key", serialized)
            self.assertIn("onyx.ava_auth.qa_documents_peer", serialized)
            self.assertIn(f"source={ROOT / 'native_modules/onyx/auth/qa_documents.py'},target=/app/onyx/ava_auth/qa_documents.py,readonly", serialized)
            self.assertIn(f"source={ROOT / 'native_modules/onyx/auth/qa_documents_peer.py'},target=/app/onyx/ava_auth/qa_documents_peer.py,readonly", serialized)
            env_path = Path(command[command.index("--env-file") + 1])
            self.assertFalse(env_path.exists())

    def test_selected_env_contains_only_peer_probe_runtime_values(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "native.env"
            row = {"id": self.deployment_id, "businessId": 911001, "revision": 4, "namespace": self.namespace}
            path.write_text("\n".join((
                "AVA_BUSINESS_ID=911001", f"AVA_DEPLOYMENT_ID={self.deployment_id}",
                f"AVA_DEPLOYMENT_NAMESPACE={self.namespace}", "AVA_DEPLOYMENT_REVISION=4",
                f"OPENSEARCH_ADMIN_USERNAME={self.namespace}_runtime",
                "OPENSEARCH_ADMIN_PASSWORD=" + "s" * 43,
                "OPENSEARCH_VERIFY_CERTS=true", "OPENSEARCH_CA_CERTS=/run/ava-search-ca/ca.pem",
                "POSTGRES_PASSWORD=must-not-copy", "S3_AWS_SECRET_ACCESS_KEY=must-not-copy",
            )) + "\n")
            with mock.patch.object(runner.qa.helper, "owned_path", side_effect=lambda value, **_: Path(value)):
                selected = runner._selected_env(path, row).decode()
            self.assertNotIn("POSTGRES", selected)
            self.assertNotIn("S3_", selected)
            self.assertNotIn("AVA_AUTH_STATE_FILE", selected)
            self.assertNotIn("AVA_AUTH_ENCRYPTION_KEY_FILE", selected)
            self.assertIn("AVA_AUTH_WORKER_KEY_FILE=/run/ava-peer/worker.key", selected)
            self.assertIn("AVA_NATIVE_HTTP_GATEWAY_KEY_FILE=/run/ava-peer/gateway.key", selected)

    def test_helper_source_hash_changes_bundle_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            peer_source, helper_source = root / "qa_documents_peer.py", root / "qa_documents.py"
            peer_source.write_text("peer-v1")
            helper_source.write_text("helper-v1")
            first = runner._source_hashes(peer_source, helper_source)
            helper_source.write_text("helper-v2")
            second = runner._source_hashes(peer_source, helper_source)
            self.assertEqual(first["probe_sha256"], second["probe_sha256"])
            self.assertNotEqual(first["helper_sha256"], second["helper_sha256"])
            self.assertNotEqual(first["source_bundle_sha256"], second["source_bundle_sha256"])


if __name__ == "__main__":
    unittest.main()
