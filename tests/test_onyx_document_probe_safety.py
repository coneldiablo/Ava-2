"""Safety, contract, and isolation unit tests for Onyx document QA probe."""
from __future__ import annotations

import ast
import asyncio
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
import uuid

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "native_modules/onyx"))

import auth.core as auth_core
import auth.qa_documents as qa_docs


class NativeFixture:
    """Contract fake for CommunityOnyx used strictly in unit tests."""
    cookie_name = "fastapiusersauth"
    backend_name = "redis"

    def __init__(self) -> None:
        self.tokens: dict[str, str] = {}
        self.users: set[str] = set()

    async def ensure_user(self, value: str) -> None:
        self.users.add(value)

    async def verify_user(self, value: str) -> list[str]:
        if value not in self.users:
            raise auth_core.Denied()
        return ["basic"]

    async def write_token(self, value: str, ttl: int) -> str:
        assert ttl > 0
        token = "T" + uuid.uuid4().hex
        self.tokens[token] = value
        return token

    async def read_token(self, token: str, value: str, expires_at: int) -> bool:
        return self.tokens.get(token) == value

    async def destroy_token(self, token: str, value: str) -> None:
        if self.tokens.get(token) == value:
            del self.tokens[token]

    async def revoke_owned_tokens(self, value: str) -> bool:
        for token, owner in list(self.tokens.items()):
            if owner == value:
                del self.tokens[token]
        return True

    async def disable_user(self, value: str) -> None:
        self.users.discard(value)


class OnyxDocumentProbeSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="test-onyx-doc-safety-")
        self.root = Path(self.temp_dir.name)
        self.encryption_file = self.root / "encryption.key"
        self.encryption_file.write_text("a" * 64)
        self.encryption_file.chmod(0o600)

        self.deployment_id = str(uuid.uuid4())
        self.namespace = "ava_" + "f" * 32
        self.business_id = 911001

        self.clean_env = {
            "AVA_NATIVE_QA": "true",
            "AVA_BUSINESS_ID": str(self.business_id),
            "AVA_DEPLOYMENT_ID": self.deployment_id,
            "AVA_DEPLOYMENT_NAMESPACE": self.namespace,
            "AVA_AUTH_ENCRYPTION_KEY_FILE": str(self.encryption_file),
            "AVA_SEARCH_RUNTIME_USER": self.namespace + "_runtime",
            "AVA_SEARCH_RUNTIME_PASSWORD": "unit-test-runtime-password-32-characters",
        }
        self.prev_env = {k: os.environ.get(k) for k in self.clean_env}
        os.environ.update(self.clean_env)

    def tearDown(self) -> None:
        for k, v in self.prev_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.temp_dir.cleanup()

    def test_fails_closed_when_ava_native_qa_not_true(self) -> None:
        """Probe must fail closed immediately if AVA_NATIVE_QA != 'true'."""
        for invalid_val in (None, "", "false", "1", "TRUE"):
            if invalid_val is None:
                os.environ.pop("AVA_NATIVE_QA", None)
            else:
                os.environ["AVA_NATIVE_QA"] = invalid_val

            with self.assertRaises(auth_core.Denied):
                asyncio.run(qa_docs.probe(native=NativeFixture()))

            # Verify main() entrypoint exits with code 1 and safe JSON
            buffer = io.StringIO()
            with mock.patch("sys.stdout", buffer):
                code = qa_docs.main()
            self.assertEqual(code, 1)
            output = json.loads(buffer.getvalue().strip())
            self.assertFalse(output["ok"])
            self.assertEqual(output["stage"], "document_qa_probe_failed")
            self.assertEqual(output["error_type"], "Denied")
            self.assertIn("frames", output)

    def test_rejects_production_business_ids(self) -> None:
        """Synthetic business IDs < 900000 must be rejected to protect production."""
        for prod_id in ("1", "7", "42", "899999", "0", "-1"):
            os.environ["AVA_BUSINESS_ID"] = prod_id
            with self.assertRaises(auth_core.Denied):
                asyncio.run(qa_docs.probe(native=NativeFixture()))

            buffer = io.StringIO()
            with mock.patch("sys.stdout", buffer):
                code = qa_docs.main()
            self.assertEqual(code, 1)
            output = json.loads(buffer.getvalue().strip())
            self.assertFalse(output["ok"])

    def test_rejects_missing_or_invalid_environment(self) -> None:
        """Probe fails closed if required contour inputs are missing or invalid."""
        # Missing deployment ID
        os.environ.pop("AVA_DEPLOYMENT_ID", None)
        with self.assertRaises(auth_core.Denied):
            asyncio.run(qa_docs.probe(native=NativeFixture()))
        os.environ["AVA_DEPLOYMENT_ID"] = self.deployment_id

        # Invalid namespace
        os.environ["AVA_DEPLOYMENT_NAMESPACE"] = "not_a_valid_namespace"
        with self.assertRaises(auth_core.Denied):
            asyncio.run(qa_docs.probe(native=NativeFixture()))
        os.environ["AVA_DEPLOYMENT_NAMESPACE"] = self.namespace

        # Invalid encryption key file
        bad_key = self.root / "bad.key"
        bad_key.write_text("short")
        bad_key.chmod(0o600)
        os.environ["AVA_AUTH_ENCRYPTION_KEY_FILE"] = str(bad_key)
        with self.assertRaises(auth_core.Denied):
            asyncio.run(qa_docs.probe(native=NativeFixture()))

    def test_rejects_non_redis_backend(self) -> None:
        """Lost-mint and token enumeration semantics require Redis backend."""
        fake = NativeFixture()
        fake.backend_name = "postgres"
        with self.assertRaises(auth_core.Unavailable):
            asyncio.run(qa_docs.probe(native=fake))

    def test_secret_free_output_contract_on_failure(self) -> None:
        """Never leak passwords, connection strings, tokens, or traceback locals in stdout JSON."""
        secret_leak = "postgres://admin:SUPER_SECRET_PASSWORD@10.0.0.1:5432/db"
        with mock.patch.object(qa_docs, "_required", side_effect=RuntimeError(secret_leak)):
            buffer = io.StringIO()
            with mock.patch("sys.stdout", buffer):
                code = qa_docs.main()
            self.assertEqual(code, 1)
            raw = buffer.getvalue()
            self.assertNotIn("SUPER_SECRET_PASSWORD", raw)
            self.assertNotIn("10.0.0.1", raw)
            parsed = json.loads(raw.strip())
            self.assertFalse(parsed["ok"])
            self.assertEqual(parsed["stage"], "document_qa_probe_failed")
            self.assertEqual(parsed["error_type"], "RuntimeError")
            # Only frames with filename, function, line exist
            for frame in parsed["frames"]:
                self.assertEqual(set(frame.keys()), {"file", "function", "line"})

    def test_ast_source_safety_contract(self) -> None:
        """Static AST analysis verifying safety boundaries, constants, and endpoints."""
        source_path = ROOT / "native_modules/onyx/auth/qa_documents.py"
        source = source_path.read_text(encoding="utf-8")
        tree = ast.parse(source)

        # Verify constants and critical checks
        self.assertIn("AVA_NATIVE_QA", source)
        self.assertIn("business_id not in (911001, 911002)", source)
        self.assertIn("911002", source)
        self.assertIn("X-Ava-Native-Peer", source)
        self.assertIn("X-Ava-Native-Binding", source)
        self.assertIn("Cookie", source)
        self.assertIn("/user/projects/file/upload", source)
        self.assertIn("/user/projects/file/statuses", source)
        self.assertIn("/user/projects/file/", source)
        self.assertIn("_documents*/_count", source)
        self.assertIn("COMPLETED", source)

        # Ensure no hardcoded raw secrets exist
        self.assertNotRegex(source, r"(?i)password\s*=\s*['\"][a-zA-Z0-9]{8,}['\"]")
        self.assertNotIn("Bearer ", source)

    def test_probe_happy_path_with_mocked_http_and_opensearch(self) -> None:
        """Verify the full lifecycle: upload, status polling, count > 0, cross-scope deny, delete, count == 0."""
        test_file_id = str(uuid.uuid4())
        native = NativeFixture()

        uploaded = {"called": False}
        polled = {"count": 0}
        deleted = {"called": False}
        foreign_read = {"called": False}
        foreign_delete = {"called": False}

        def mock_handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            method = request.method

            # Check peer and binding headers
            peer = request.headers.get("X-Ava-Native-Peer")
            binding = request.headers.get("X-Ava-Native-Binding")
            cookie = request.headers.get("Cookie")
            assert peer is not None
            assert binding is not None
            assert cookie is not None and "fastapiusersauth=" in cookie

            # Handle cross-scope foreign session requests
            if "qa-foreign-" in str(request.headers):
                pass

            if path == "/user/projects/file/upload" and method == "POST":
                uploaded["called"] = True
                return httpx.Response(200, json={"file_ids": [test_file_id]})

            elif path == "/user/projects/file/statuses" and method == "POST":
                polled["count"] += 1
                return httpx.Response(200, json=[{"id": test_file_id, "status": "COMPLETED"}])

            elif path == f"/user/projects/file/{test_file_id}":
                if method == "GET":
                    # Check if foreign session
                    if "foreign" in binding or request.headers.get("X-Is-Foreign") == "true":
                        foreign_read["called"] = True
                        return httpx.Response(403, json={"detail": "Forbidden"})
                    # If this is the cross-scope probe call
                    foreign_read["called"] = True
                    return httpx.Response(403, json={"detail": "Forbidden"})
                elif method == "DELETE":
                    if not deleted["called"]:
                        # Foreign delete check happens before own delete
                        foreign_delete["called"] = True
                        return httpx.Response(403, json={"detail": "Forbidden"})
                    return httpx.Response(200, json={"has_associations": False})

            return httpx.Response(404, json={"detail": "Not found"})

        counts = [1, 0]  # First poll expect_positive -> 1; after delete expect_zero -> 0

        async def mock_poll_opensearch(namespace: str, *, expect_positive: bool, **kwargs) -> int:
            return 1 if expect_positive else 0

        async def mock_cross_scope_os(foreign_namespace: str, **kwargs) -> bool:
            return True

        mock_client = httpx.AsyncClient(base_url="https://native.invalid", transport=httpx.MockTransport(mock_handler))

        # First foreign delete should return 403, then own delete returns 200
        call_seq = {"delete_count": 0}

        def dynamic_handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            method = request.method
            if path == "/user/projects/file/upload" and method == "POST":
                uploaded["called"] = True
                return httpx.Response(200, json={"file_ids": [test_file_id]})
            elif path == "/user/projects/file/statuses" and method == "POST":
                polled["count"] += 1
                return httpx.Response(200, json=[{"id": test_file_id, "status": "COMPLETED"}])
            elif path == f"/user/projects/file/{test_file_id}":
                if method == "GET":
                    foreign_read["called"] = True
                    return httpx.Response(403, json={"detail": "Forbidden"})
                elif method == "DELETE":
                    call_seq["delete_count"] += 1
                    if call_seq["delete_count"] == 1:
                        # 1st delete is foreign delete check
                        foreign_delete["called"] = True
                        return httpx.Response(403, json={"detail": "Forbidden"})
                    else:
                        # 2nd delete is own delete
                        deleted["called"] = True
                        return httpx.Response(200, json={"has_associations": False})
            return httpx.Response(404, json={"detail": "Not found"})

        mock_client = httpx.AsyncClient(base_url="https://native.invalid", transport=httpx.MockTransport(dynamic_handler))

        with mock.patch.object(qa_docs, "poll_opensearch_count", side_effect=mock_poll_opensearch), \
             mock.patch.object(qa_docs, "check_opensearch_cross_scope", side_effect=mock_cross_scope_os):
            evidence = asyncio.run(
                qa_docs.probe(
                    client=mock_client,
                    native=native,
                    max_poll_iterations=5,
                    poll_interval=0.01,
                )
            )

        self.assertTrue(uploaded["called"])
        self.assertGreater(polled["count"], 0)
        self.assertTrue(foreign_read["called"])
        self.assertTrue(foreign_delete["called"])
        self.assertTrue(deleted["called"])
        self.assertEqual(native.tokens, {}, "Both owned and foreign QA tokens must be revoked")
        self.assertEqual(native.users, set(), "Both QA identities must be disabled")

        expected_flags = {
            "provisioned": True,
            "session_created": True,
            "upload_status_ok": True,
            "file_indexed_completed": True,
            "opensearch_indexed": True,
            "file_deleted": True,
            "opensearch_purged": True,
            "cross_scope_read_denied": True,
            "cross_scope_delete_denied": True,
            "cross_scope_opensearch_denied": True,
            "cleaned_up": True,
        }
        self.assertEqual(evidence, expected_flags)

    def test_probe_upload_failure_fails_closed(self) -> None:
        """Non-200 upload response raises Unavailable and cleans up."""
        native = NativeFixture()

        def fail_upload(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"detail": "Internal Server Error"})

        mock_client = httpx.AsyncClient(base_url="https://native.invalid", transport=httpx.MockTransport(fail_upload))

        with self.assertRaises(auth_core.Unavailable):
            asyncio.run(qa_docs.probe(client=mock_client, native=native, poll_interval=0.01))

    def test_probe_polling_timeout_fails_closed(self) -> None:
        """File never reaching COMPLETED within timeout raises Unavailable."""
        native = NativeFixture()
        test_file_id = str(uuid.uuid4())

        def stuck_processing(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/user/projects/file/upload":
                return httpx.Response(200, json={"file_ids": [test_file_id]})
            return httpx.Response(200, json=[{"id": test_file_id, "status": "INDEXING"}])

        mock_client = httpx.AsyncClient(base_url="https://native.invalid", transport=httpx.MockTransport(stuck_processing))

        with self.assertRaises(auth_core.Unavailable):
            asyncio.run(
                qa_docs.probe(
                    client=mock_client,
                    native=native,
                    max_poll_iterations=3,
                    poll_interval=0.01,
                )
            )

    def test_probe_failed_status_fails_closed(self) -> None:
        """File status reaching FAILED raises Unavailable immediately."""
        native = NativeFixture()
        test_file_id = str(uuid.uuid4())

        def fail_indexing(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/user/projects/file/upload":
                return httpx.Response(200, json={"file_ids": [test_file_id]})
            return httpx.Response(200, json=[{"id": test_file_id, "status": "FAILED"}])

        mock_client = httpx.AsyncClient(base_url="https://native.invalid", transport=httpx.MockTransport(fail_indexing))

        with self.assertRaises(auth_core.Unavailable):
            asyncio.run(
                qa_docs.probe(
                    client=mock_client,
                    native=native,
                    max_poll_iterations=5,
                    poll_interval=0.01,
                )
            )

    def test_probe_opensearch_count_zero_fails_closed(self) -> None:
        """If document count is 0 after indexing COMPLETED, probe must fail."""
        native = NativeFixture()
        test_file_id = str(uuid.uuid4())

        def ok_upload_status(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/user/projects/file/upload":
                return httpx.Response(200, json={"file_ids": [test_file_id]})
            return httpx.Response(200, json=[{"id": test_file_id, "status": "COMPLETED"}])

        mock_client = httpx.AsyncClient(base_url="https://native.invalid", transport=httpx.MockTransport(ok_upload_status))

        with mock.patch.object(qa_docs, "poll_opensearch_count", return_value=0):
            with self.assertRaises(auth_core.Unavailable):
                asyncio.run(qa_docs.probe(client=mock_client, native=native, poll_interval=0.01))

    def test_probe_opensearch_unpurged_fails_closed(self) -> None:
        """If document count remains > 0 after deletion, probe must fail."""
        native = NativeFixture()
        test_file_id = str(uuid.uuid4())

        seq = {"del": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/user/projects/file/upload":
                return httpx.Response(200, json={"file_ids": [test_file_id]})
            elif request.url.path == "/user/projects/file/statuses":
                return httpx.Response(200, json=[{"id": test_file_id, "status": "COMPLETED"}])
            elif request.url.path == f"/user/projects/file/{test_file_id}":
                if request.method == "GET":
                    return httpx.Response(403, json={})
                seq["del"] += 1
                if seq["del"] == 1:
                    return httpx.Response(403, json={})
                return httpx.Response(200, json={})
            return httpx.Response(404, json={})

        mock_client = httpx.AsyncClient(base_url="https://native.invalid", transport=httpx.MockTransport(handler))

        # First return 1 (indexed), second return 1 (failed to purge!)
        counts = [1, 1]

        async def mock_poll(namespace: str, *, expect_positive: bool, **kwargs) -> int:
            return 1

        with mock.patch.object(qa_docs, "poll_opensearch_count", side_effect=mock_poll), \
             mock.patch.object(qa_docs, "check_opensearch_cross_scope", return_value=True):
            with self.assertRaises(auth_core.Unavailable):
                asyncio.run(qa_docs.probe(client=mock_client, native=native, poll_interval=0.01))

    def test_probe_cross_scope_read_leak_fails_closed(self) -> None:
        """If foreign session successfully reads the document (200 OK), probe raises Denied."""
        native = NativeFixture()
        test_file_id = str(uuid.uuid4())

        def leaking_read(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/user/projects/file/upload":
                return httpx.Response(200, json={"file_ids": [test_file_id]})
            elif request.url.path == "/user/projects/file/statuses":
                return httpx.Response(200, json=[{"id": test_file_id, "status": "COMPLETED"}])
            elif request.url.path == f"/user/projects/file/{test_file_id}" and request.method == "GET":
                # Security violation: foreign user got 200 OK!
                return httpx.Response(200, json={"file_id": test_file_id, "title": "secret"})
            return httpx.Response(404, json={})

        mock_client = httpx.AsyncClient(base_url="https://native.invalid", transport=httpx.MockTransport(leaking_read))

        with mock.patch.object(qa_docs, "poll_opensearch_count", return_value=1), \
             mock.patch.object(qa_docs, "check_opensearch_cross_scope", return_value=True):
            with self.assertRaises(auth_core.Denied):
                asyncio.run(qa_docs.probe(client=mock_client, native=native, poll_interval=0.01))

    def test_probe_cross_scope_delete_leak_fails_closed(self) -> None:
        """If foreign session successfully deletes the document (200 OK), probe raises Denied."""
        native = NativeFixture()
        test_file_id = str(uuid.uuid4())

        def leaking_delete(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/user/projects/file/upload":
                return httpx.Response(200, json={"file_ids": [test_file_id]})
            elif request.url.path == "/user/projects/file/statuses":
                return httpx.Response(200, json=[{"id": test_file_id, "status": "COMPLETED"}])
            elif request.url.path == f"/user/projects/file/{test_file_id}":
                if request.method == "GET":
                    return httpx.Response(403, json={})
                # Foreign delete returns 200 (leak!)
                return httpx.Response(200, json={"deleted": True})
            return httpx.Response(404, json={})

        mock_client = httpx.AsyncClient(base_url="https://native.invalid", transport=httpx.MockTransport(leaking_delete))

        with mock.patch.object(qa_docs, "poll_opensearch_count", return_value=1), \
             mock.patch.object(qa_docs, "check_opensearch_cross_scope", return_value=True):
            with self.assertRaises(auth_core.Denied):
                asyncio.run(qa_docs.probe(client=mock_client, native=native, poll_interval=0.01))

    def test_probe_cross_scope_opensearch_leak_fails_closed(self) -> None:
        """If OpenSearch foreign index is accessible, probe raises Denied."""
        native = NativeFixture()
        test_file_id = str(uuid.uuid4())

        def ok_handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/user/projects/file/upload":
                return httpx.Response(200, json={"file_ids": [test_file_id]})
            elif request.url.path == "/user/projects/file/statuses":
                return httpx.Response(200, json=[{"id": test_file_id, "status": "COMPLETED"}])
            elif request.url.path == f"/user/projects/file/{test_file_id}":
                return httpx.Response(403, json={})
            return httpx.Response(404, json={})

        mock_client = httpx.AsyncClient(base_url="https://native.invalid", transport=httpx.MockTransport(ok_handler))

        with mock.patch.object(qa_docs, "poll_opensearch_count", return_value=1), \
             mock.patch.object(qa_docs, "check_opensearch_cross_scope", return_value=False):
            with self.assertRaises(auth_core.Denied):
                asyncio.run(qa_docs.probe(client=mock_client, native=native, poll_interval=0.01))

    def test_environment_variables_restored_on_exit(self) -> None:
        """Verify environment variables modified during probe are safely restored."""
        original_guard = os.environ.get("AVA_NATIVE_HTTP_GUARD")
        original_state = os.environ.get("AVA_AUTH_STATE_FILE")
        original_gw = os.environ.get("AVA_NATIVE_HTTP_GATEWAY_KEY_FILE")

        native = NativeFixture()

        def err_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500)

        mock_client = httpx.AsyncClient(base_url="https://native.invalid", transport=httpx.MockTransport(err_handler))

        with self.assertRaises(auth_core.Unavailable):
            asyncio.run(qa_docs.probe(client=mock_client, native=native, poll_interval=0.01))

        self.assertEqual(os.environ.get("AVA_NATIVE_HTTP_GUARD"), original_guard)
        self.assertEqual(os.environ.get("AVA_AUTH_STATE_FILE"), original_state)
        self.assertEqual(os.environ.get("AVA_NATIVE_HTTP_GATEWAY_KEY_FILE"), original_gw)

    def test_opensearch_query_helpers(self) -> None:
        """Test query_opensearch_count and check_opensearch_cross_scope HTTP mappings."""
        # 1. Successful count
        def os_count_ok(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"count": 42})

        with mock.patch("httpx.AsyncClient", return_value=httpx.AsyncClient(transport=httpx.MockTransport(os_count_ok))):
            count = asyncio.run(qa_docs.query_opensearch_count(self.namespace))
            self.assertEqual(count, 42)

        # 2. A missing index cannot prove successful physical deletion.
        def os_count_404(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={})

        with mock.patch("httpx.AsyncClient", return_value=httpx.AsyncClient(transport=httpx.MockTransport(os_count_404))):
            with self.assertRaises(auth_core.Unavailable):
                asyncio.run(qa_docs.query_opensearch_count(self.namespace))

        # 3. Denied (403) raises Denied
        def os_count_403(request: httpx.Request) -> httpx.Response:
            return httpx.Response(403, json={})

        with mock.patch("httpx.AsyncClient", return_value=httpx.AsyncClient(transport=httpx.MockTransport(os_count_403))):
            with self.assertRaises(auth_core.Denied):
                asyncio.run(qa_docs.query_opensearch_count(self.namespace))

        # 4. Error (500) raises Unavailable
        def os_count_500(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={})

        with mock.patch("httpx.AsyncClient", return_value=httpx.AsyncClient(transport=httpx.MockTransport(os_count_500))):
            with self.assertRaises(auth_core.Unavailable):
                asyncio.run(qa_docs.query_opensearch_count(self.namespace))

        # 5. Cross-scope returns True on 403
        with mock.patch("httpx.AsyncClient", return_value=httpx.AsyncClient(transport=httpx.MockTransport(os_count_403))):
            self.assertTrue(asyncio.run(qa_docs.check_opensearch_cross_scope("ava_" + "e" * 32)))

        # 6. Cross-scope returns False on 200 (leak!)
        def os_count_leak(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"count": 1})

        with mock.patch("httpx.AsyncClient", return_value=httpx.AsyncClient(transport=httpx.MockTransport(os_count_leak))):
            self.assertFalse(asyncio.run(qa_docs.check_opensearch_cross_scope("ava_" + "e" * 32)))


if __name__ == "__main__":
    unittest.main()
