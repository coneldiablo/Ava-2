"""Mocked contract tests; these are not live Onyx or native acceptance."""
from __future__ import annotations

import asyncio
import ast
import importlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import uuid

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "native_modules/onyx"))
import auth.core as core
import auth.qa_documents_peer as peer


class OnyxDocumentPeerProbeTests(unittest.TestCase):
    def setUp(self):
        self.deployment = str(uuid.uuid4())
        self.namespace = "ava_" + self.deployment.replace("-", "")
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.gateway, self.worker = root / "gateway.key", root / "worker.key"
        self.gateway.write_text("g" * 43); self.worker.write_text("w" * 43)
        self.gateway.chmod(0o600); self.worker.chmod(0o600)
        self.previous = {key: os.environ.get(key) for key in (
            "AVA_NATIVE_QA", "AVA_BUSINESS_ID", "AVA_DEPLOYMENT_ID", "AVA_DEPLOYMENT_NAMESPACE",
            "AVA_AUTH_GATEWAY_KEY_FILE", "AVA_AUTH_WORKER_KEY_FILE", "AVA_NATIVE_HTTP_GATEWAY_KEY_FILE",
        )}
        os.environ.update({
            "AVA_NATIVE_QA": "true", "AVA_BUSINESS_ID": "911001",
            "AVA_DEPLOYMENT_ID": self.deployment, "AVA_DEPLOYMENT_NAMESPACE": self.namespace,
            "AVA_AUTH_GATEWAY_KEY_FILE": str(self.gateway), "AVA_AUTH_WORKER_KEY_FILE": str(self.worker),
            "AVA_NATIVE_HTTP_GATEWAY_KEY_FILE": str(self.gateway),
        })

    def tearDown(self):
        for key, value in self.previous.items():
            if value is None: os.environ.pop(key, None)
            else: os.environ[key] = value
        self.temporary.cleanup()

    def clients(self, *, upload_status=200):
        state = {"disabled": False, "auth_paths": []}
        file_id = str(uuid.uuid4())

        def auth_handler(request: httpx.Request):
            state["auth_paths"].append(request.url.path)
            body = __import__("json").loads(request.read())
            bearer = request.headers.get("authorization")
            if request.url.path in ("/v1/provision", "/v1/users/disable") and bearer != "Bearer " + "w" * 43:
                return httpx.Response(403)
            if request.url.path.startswith("/v1/sessions/") and bearer != "Bearer " + "g" * 43:
                return httpx.Response(403)
            if request.url.path == "/v1/provision":
                if body["deploymentId"] != self.deployment or state["disabled"]:
                    return httpx.Response(403)
                return httpx.Response(200, json={**body, "nativeUserId": str(uuid.uuid5(uuid.UUID(self.deployment), "ava-user:" + body["userId"])), "state": "active"})
            if request.url.path == "/v1/sessions/create":
                if state["disabled"]: return httpx.Response(403)
                fields = ("businessId", "deploymentId", "bindingId", "userId", "nativeUserId", "nativeScope")
                return httpx.Response(200, json={**{key: body[key] for key in fields},
                                                 "nativeCookie": "fastapiusersauth=" + "t" * 32,
                                                 "nativeSessionId": "a" * 64})
            if request.url.path == "/v1/sessions/revoke":
                return httpx.Response(200, json={"bindingId": body["bindingId"], "nativeSessionAbsent": True})
            if request.url.path == "/v1/users/disable":
                state["disabled"] = True
                native_id = str(uuid.uuid5(uuid.UUID(self.deployment), "ava-user:" + body["userId"]))
                return httpx.Response(200, json={**body, "nativeUserId": native_id, "state": "disabled", "nativeSessionsAbsent": True})
            return httpx.Response(404)

        def api_handler(request: httpx.Request):
            unknown = request.headers.get("x-ava-native-binding") not in (None, state.get("binding"))
            if request.url.path.endswith("/upload"):
                if upload_status != 200: return httpx.Response(upload_status)
                state["binding"] = request.headers["x-ava-native-binding"]
                return httpx.Response(200, json={"file_ids": [file_id]})
            if request.url.path.endswith("/statuses"):
                return httpx.Response(200, json=[{"id": file_id, "status": "COMPLETED"}])
            if request.url.path.endswith(file_id) and unknown:
                return httpx.Response(403)
            if request.method == "DELETE" and request.url.path.endswith(file_id):
                return httpx.Response(200, json={"has_associations": False})
            return httpx.Response(404)

        auth = httpx.AsyncClient(base_url="http://auth.test", transport=httpx.MockTransport(auth_handler))
        api = httpx.AsyncClient(base_url="http://api.test", transport=httpx.MockTransport(api_handler))
        return state, auth, api

    def test_complete_probe_uses_remote_peers_and_honest_negative_labels(self):
        state, auth, api = self.clients()
        with mock.patch.object(peer, "poll_opensearch_count", side_effect=(2, 0)), \
             mock.patch.object(peer, "check_opensearch_cross_scope", return_value=True):
            result = asyncio.run(peer.probe(auth_client=auth, api_client=api, max_poll_iterations=1, poll_interval=0))
        asyncio.run(auth.aclose()); asyncio.run(api.aclose())
        self.assertTrue(all(result.values()))
        self.assertEqual(state["auth_paths"].count("/v1/sessions/revoke"), 2)
        self.assertIn("/v1/users/disable", state["auth_paths"])
        self.assertEqual(state["auth_paths"][-2:], ["/v1/sessions/create", "/v1/provision"])

    def test_failure_still_attempts_per_user_remote_cleanup(self):
        state, auth, api = self.clients(upload_status=500)
        with self.assertRaises(core.Unavailable):
            asyncio.run(peer.probe(auth_client=auth, api_client=api, max_poll_iterations=1, poll_interval=0))
        asyncio.run(auth.aclose()); asyncio.run(api.aclose())
        self.assertIn("/v1/sessions/revoke", state["auth_paths"])
        self.assertIn("/v1/users/disable", state["auth_paths"])
        self.assertTrue(state["disabled"])

    def test_peer_probe_does_not_import_or_open_auth_state(self):
        source = (ROOT / "native_modules/onyx/auth/qa_documents_peer.py").read_text()
        tree = ast.parse(source)
        imported = {alias.name for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) for alias in node.names}
        self.assertFalse({"Store", "Service", "CommunityOnyx"} & imported)
        self.assertNotIn("AVA_AUTH_ENCRYPTION_KEY_FILE", source)
        self.assertNotIn("AVA_AUTH_STATE_FILE", source)


if __name__ == "__main__": unittest.main()
