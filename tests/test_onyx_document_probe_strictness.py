"""Strict OpenSearch and deletion-path regressions for the Onyx QA probe.

These tests use mocked HTTP only. They exercise the probe's decision logic,
not a live Onyx deployment or native acceptance.
"""
from __future__ import annotations

import ast
import asyncio
import os
import sys
import unittest
import uuid
from pathlib import Path
from unittest import mock

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "native_modules/onyx"))

import auth.core as auth_core
import auth.qa_documents as qa_docs


class OnyxDocumentProbeStrictnessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.namespace = "ava_" + "a" * 32
        self.foreign_namespace = "ava_" + "b" * 32
        self.file_id = str(uuid.uuid4())
        self.old_env = {
            key: os.environ.get(key)
            for key in (
                "AVA_DEPLOYMENT_NAMESPACE",
                "AVA_OPENSEARCH_URL",
                "AVA_SEARCH_RUNTIME_USER",
                "AVA_SEARCH_RUNTIME_PASSWORD",
                "OPENSEARCH_ADMIN_USERNAME",
                "OPENSEARCH_ADMIN_PASSWORD",
                "OPENSEARCH_USER",
                "OPENSEARCH_PASSWORD",
                "OPENSEARCH_VERIFY_CERTS",
            )
        }
        os.environ.update({
            "AVA_DEPLOYMENT_NAMESPACE": self.namespace,
            "AVA_OPENSEARCH_URL": "https://search:9200",
            "AVA_SEARCH_RUNTIME_USER": self.namespace + "_runtime",
            "AVA_SEARCH_RUNTIME_PASSWORD": "unit-test-runtime-password-0123456789abcdef",
            "OPENSEARCH_VERIFY_CERTS": "true",
        })
        for key in (
            "OPENSEARCH_ADMIN_USERNAME", "OPENSEARCH_ADMIN_PASSWORD",
            "OPENSEARCH_USER", "OPENSEARCH_PASSWORD",
        ):
            os.environ.pop(key, None)

    def tearDown(self) -> None:
        for key, value in self.old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _mock_async_client(self, handler):
        """Patch the probe's client constructor while keeping all I/O mocked."""
        real_async_client = httpx.AsyncClient
        options = []

        def factory(*args, **kwargs):
            options.append(kwargs.copy())
            return real_async_client(transport=httpx.MockTransport(handler), **kwargs)

        return mock.patch.object(qa_docs.httpx, "AsyncClient", side_effect=factory), options

    def test_cross_scope_only_403_proves_denial(self) -> None:
        for status in (401, 404, 500):
            with self.subTest(status=status):
                patcher, _ = self._mock_async_client(lambda _request, s=status: httpx.Response(s))
                with patcher:
                    with self.assertRaises(auth_core.Unavailable):
                        asyncio.run(qa_docs.check_opensearch_cross_scope(self.foreign_namespace))

        patcher, _ = self._mock_async_client(lambda _request: httpx.Response(200, json={"count": 0}))
        with patcher:
            self.assertFalse(asyncio.run(qa_docs.check_opensearch_cross_scope(self.foreign_namespace)))

        patcher, _ = self._mock_async_client(lambda _request: httpx.Response(403))
        with patcher:
            self.assertTrue(asyncio.run(qa_docs.check_opensearch_cross_scope(self.foreign_namespace)))

    def test_cross_scope_transport_error_is_not_a_denial(self) -> None:
        def fail(_request):
            raise httpx.ConnectError("mock transport failure")

        patcher, _ = self._mock_async_client(fail)
        with patcher:
            with self.assertRaises(auth_core.Unavailable):
                asyncio.run(qa_docs.check_opensearch_cross_scope(self.foreign_namespace))

    def test_cross_scope_rejects_invalid_or_own_namespace(self) -> None:
        for namespace in ("not-a-namespace", self.namespace):
            with self.subTest(namespace=namespace):
                with self.assertRaises(auth_core.Denied):
                    asyncio.run(qa_docs.check_opensearch_cross_scope(namespace))

    def test_opensearch_requires_verified_https_and_runtime_username(self) -> None:
        os.environ["OPENSEARCH_VERIFY_CERTS"] = "false"
        with self.assertRaises(auth_core.Denied):
            asyncio.run(qa_docs.query_opensearch_count(self.namespace, file_id=self.file_id))
        with self.assertRaises(auth_core.Denied):
            asyncio.run(qa_docs.check_opensearch_cross_scope(self.foreign_namespace))
        os.environ["OPENSEARCH_VERIFY_CERTS"] = "true"

        for helper_name, helper_call in (
            ("count", lambda url: qa_docs.query_opensearch_count(
                self.namespace, file_id=self.file_id, base_url=url)),
            ("cross_scope", lambda url: qa_docs.check_opensearch_cross_scope(
                self.foreign_namespace, base_url=url)),
        ):
            with self.subTest(helper=helper_name, url="http://search:9200"):
                with self.assertRaises(auth_core.Denied):
                    asyncio.run(helper_call("http://search:9200"))

        for helper_call in (
            lambda: qa_docs.query_opensearch_count(
                self.namespace, file_id=self.file_id, username="admin", password="not-a-runtime-user"),
            lambda: qa_docs.check_opensearch_cross_scope(
                self.foreign_namespace, username="admin", password="admin-password"),
        ):
            with self.subTest(helper=helper_call):
                with self.assertRaises(auth_core.Denied):
                    asyncio.run(helper_call())

    def test_file_count_uses_exact_document_id_term_query_and_runtime_auth(self) -> None:
        seen = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"count": 3})

        patcher, options = self._mock_async_client(handler)
        with patcher:
            result = asyncio.run(qa_docs.query_opensearch_count(self.namespace, file_id=self.file_id))

        self.assertEqual(result, 3)
        self.assertEqual(len(seen), 1)
        request = seen[0]
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.url.path, f"/{self.namespace}_documents*/_count")
        self.assertEqual(__import__("json").loads(request.read()), {
            "query": {"term": {"document_id": self.file_id}}
        })
        self.assertEqual(request.headers.get("authorization"), httpx.BasicAuth(
            self.namespace + "_runtime", "unit-test-runtime-password-0123456789abcdef"
        )._auth_header)
        self.assertTrue(options)
        self.assertTrue(options[0].get("verify", True))

    def test_file_count_rejects_missing_invalid_and_error_responses(self) -> None:
        for payload in ({}, {"count": -1}, {"count": True}, {"count": "1"}, {"count": 1.5}):
            with self.subTest(payload=payload):
                patcher, _ = self._mock_async_client(lambda _request, p=payload: httpx.Response(200, json=p))
                with patcher:
                    with self.assertRaises(auth_core.Unavailable):
                        asyncio.run(qa_docs.query_opensearch_count(self.namespace, file_id=self.file_id))

        for status in (404, 401, 403, 500):
            with self.subTest(status=status):
                patcher, _ = self._mock_async_client(lambda _request, s=status: httpx.Response(s))
                with patcher:
                    with self.assertRaises((auth_core.Denied, auth_core.Unavailable)):
                        asyncio.run(qa_docs.query_opensearch_count(self.namespace, file_id=self.file_id))

        patcher, _ = self._mock_async_client(
            lambda _request: (_ for _ in ()).throw(httpx.ConnectError("mock transport failure"))
        )
        with patcher:
            with self.assertRaises(auth_core.Unavailable):
                asyncio.run(qa_docs.query_opensearch_count(self.namespace, file_id=self.file_id))

        with self.assertRaises(auth_core.Denied):
            asyncio.run(qa_docs.query_opensearch_count(self.namespace, file_id="not-a-uuid"))

    def test_file_status_does_not_fall_back_to_another_files_status(self) -> None:
        other_file = str(uuid.uuid4())
        response = [{"id": other_file, "status": "COMPLETED"}]
        self.assertIsNone(qa_docs._extract_file_status(response, self.file_id))

    def test_probe_has_no_direct_worker_delete_bypass(self) -> None:
        source_path = ROOT / "native_modules/onyx/auth/qa_documents.py"
        source = source_path.read_text(encoding="utf-8")
        tree = ast.parse(source)
        probe = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "probe")
        probe_source = ast.get_source_segment(source, probe) or ""
        self.assertNotIn("delete_user_file_impl", probe_source)
        self.assertNotIn("drain_delete_loop", probe_source)
        self.assertNotIn("redis_locking=False", probe_source)


if __name__ == "__main__":
    unittest.main()
