"""Behavior tests for the real Onyx dependency bootstrap contracts."""
import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("dependency_bootstrap", ROOT / "native_modules/onyx/dependency_bootstrap.py")
bootstrap = importlib.util.module_from_spec(spec); sys.modules[spec.name] = bootstrap; spec.loader.exec_module(bootstrap)


class FakeOpenSearch:
    def __init__(self):
        self.roles = {}
        self.users = {}
        self.indices = set()
        self.calls = []

    def __call__(self, method, path, auth, body=None):
        self.calls.append((method, path, auth[0], body))
        is_admin = auth == ("", "")
        if path == "/_plugins/_security/authinfo":
            if is_admin:
                return bootstrap.Response(200, {"user_name": "admin", "roles": ["all_access"]})
            row = self.users.get(auth[0])
            if row and auth[1] == row["password"]:
                return bootstrap.Response(200, {"user_name": auth[0], "roles": row["opendistro_security_roles"]})
            return bootstrap.Response(401, {})
        if path == "/_plugins/_security/api/internalusers" and not is_admin:
            return bootstrap.Response(403, {})
        if not is_admin and path == "/ava_outside_owned_indexes":
            return bootstrap.Response(403, {})
        if not is_admin and path.startswith("/ava_") and not path.startswith("/" + auth[0].removesuffix("_runtime") + "_documents"):
            return bootstrap.Response(403, {})
        if not is_admin and path.startswith("/" + auth[0].removesuffix("_runtime") + "_documents"):
            name = path[1:]
            if method == "HEAD":
                return bootstrap.Response(200 if name in self.indices else 404, {})
            if method == "PUT":
                self.indices.add(name); return bootstrap.Response(201, {"acknowledged": True})
            if method == "DELETE":
                self.indices.discard(name); return bootstrap.Response(200, {"acknowledged": True})
        if not is_admin:
            return bootstrap.Response(403, {})
        if path.startswith("/_plugins/_security/api/roles/"):
            name = path.rsplit("/", 1)[-1]
            if method == "GET":
                return bootstrap.Response(200 if name in self.roles else 404, {name: self.roles[name]} if name in self.roles else {})
            self.roles[name] = body
            return bootstrap.Response(201, {"status": "CREATED"})
        if path.startswith("/_plugins/_security/api/internalusers/"):
            name = path.rsplit("/", 1)[-1]
            if method == "GET":
                if name not in self.users:
                    return bootstrap.Response(404, {})
                row = self.users[name]
                return bootstrap.Response(200, {name: {"roles": row["opendistro_security_roles"], "attributes": row["attributes"]}})
            self.users[name] = body
            return bootstrap.Response(201, {"status": "CREATED"})
        raise AssertionError((method, path))


class DependencyBootstrapTests(unittest.TestCase):
    namespace = "ava_" + "a" * 32
    admin = "A" * 43
    runtime = "B" * 43

    def test_opensearch_reconcile_is_replay_safe_and_runtime_is_not_admin(self):
        server = FakeOpenSearch()
        bootstrap.reconcile_opensearch(self.namespace, self.runtime, server, pause=lambda _: None)
        bootstrap.reconcile_opensearch(self.namespace, self.runtime, server, pause=lambda _: None)
        role = server.roles[self.namespace + "_runtime"]
        self.assertEqual(role["index_permissions"][0]["index_patterns"], [self.namespace + "_documents", self.namespace + "_documents_*"])
        self.assertNotIn("all_access", json.dumps(role))
        self.assertNotIn("security_rest_api_access", json.dumps(role))
        self.assertEqual(server.users[self.namespace + "_runtime"]["password"], self.runtime)
        self.assertEqual(server.indices, set())
        # Each replay reads the owned record before replacing it. This handles a
        # duplicate or an earlier successful write whose response was lost.
        paths = [(method, path) for method, path, _user, _body in server.calls]
        role_path = "/_plugins/_security/api/roles/" + self.namespace + "_runtime"
        self.assertLess(paths.index(("GET", role_path)), paths.index(("PUT", role_path)))

    def test_wrong_runtime_binding_or_excess_privilege_fails_closed(self):
        server = FakeOpenSearch()
        original = server.__call__
        def overprivileged(method, path, auth, body=None):
            if path == "/_plugins/_security/api/internalusers" and auth != ("", ""):
                return bootstrap.Response(200, {})
            return original(method, path, auth, body)
        with self.assertRaisesRegex(bootstrap.BootstrapError, "OPENSEARCH_RUNTIME_OVERPRIVILEGED"):
            bootstrap.reconcile_opensearch(self.namespace, self.runtime, overprivileged, pause=lambda _: None)

    def test_foreign_existing_role_or_user_is_never_overwritten(self):
        role_name = self.namespace + "_runtime"
        foreign_role = FakeOpenSearch()
        foreign_role.roles[role_name] = {**bootstrap.opensearch_role(self.namespace), "description": "foreign"}
        with self.assertRaisesRegex(bootstrap.BootstrapError, "OPENSEARCH_RESOURCE_OWNERSHIP_CONFLICT"):
            bootstrap.reconcile_opensearch(self.namespace, self.runtime, foreign_role, pause=lambda _: None)
        self.assertNotIn(("PUT", "/_plugins/_security/api/roles/" + role_name), [(m, p) for m, p, _u, _b in foreign_role.calls])

        foreign_user = FakeOpenSearch()
        foreign_user.roles[role_name] = bootstrap.opensearch_role(self.namespace)
        foreign_user.users[role_name] = {"password": "C" * 43, "opendistro_security_roles": [role_name, "all_access"], "attributes": {"ava_namespace": self.namespace}}
        with self.assertRaisesRegex(bootstrap.BootstrapError, "OPENSEARCH_RESOURCE_OWNERSHIP_CONFLICT"):
            bootstrap.reconcile_opensearch(self.namespace, self.runtime, foreign_user, pause=lambda _: None)
        security_puts = [(m, p) for m, p, _u, _b in foreign_user.calls if m == "PUT"]
        self.assertEqual(security_puts, [])

        mapped_user = FakeOpenSearch()
        mapped_user.roles[role_name] = bootstrap.opensearch_role(self.namespace)
        mapped_user.users[role_name] = {"password": "C" * 43, "opendistro_security_roles": [role_name],
                                        "attributes": {"ava_namespace": self.namespace}, "backend_roles": ["foreign"]}
        original = mapped_user.__call__
        def expose_backend_roles(method, path, auth, body=None):
            response = original(method, path, auth, body)
            if method == "GET" and path.endswith("/internalusers/" + role_name) and response.status == 200:
                response.body[role_name]["backend_roles"] = ["foreign"]
            return response
        with self.assertRaisesRegex(bootstrap.BootstrapError, "OPENSEARCH_RESOURCE_OWNERSHIP_CONFLICT"):
            bootstrap.reconcile_opensearch(self.namespace, self.runtime, expose_backend_roles, pause=lambda _: None)

    def test_minio_policy_and_script_are_bucket_scoped_and_prove_runtime_io(self):
        policy = bootstrap.minio_policy(self.namespace)
        bucket = self.namespace.replace("_", "-") + "-files"
        raw = json.dumps(policy)
        self.assertIn("arn:aws:s3:::" + bucket, raw)
        self.assertNotIn('"Resource": ["*"]', raw)
        self.assertNotIn("s3:*", raw)
        self.assertIn('"Effect": "Deny"', raw)
        self.assertIn(".ava-ownership.json", raw)
        script = bootstrap.minio_bootstrap_script(self.namespace)
        for command in ("mc mb", "mc admin policy create", "mc admin user add", "mc admin policy attach", "mc cp", "mc stat", "mc rm", "mc admin info runtime"):
            self.assertIn(command, script)
        self.assertIn("admin user add admin </run/ava/minio-runtime-credentials", script)
        self.assertIn("if ! MC_CONFIG_DIR", script)
        self.assertIn("admin policy info --json admin", script)
        self.assertIn("admin user info --json admin", script)
        self.assertIn("policyName", script)
        self.assertIn("memberOf", script)
        self.assertNotIn("mc alias set", script)
        self.assertNotIn("$AVA_MINIO_RUNTIME_PASSWORD", script)
        self.assertNotIn("$MINIO_ROOT", script)
        self.assertNotIn(self.admin, script)
        self.assertNotIn(self.runtime, script)

    def test_scope_and_secret_validation_rejects_unowned_values(self):
        for namespace in ("danswer", "ava_../bad", "ava_" + "z" * 32):
            with self.subTest(namespace=namespace), self.assertRaises(bootstrap.BootstrapError):
                bootstrap.minio_policy(namespace)
        with self.assertRaisesRegex(bootstrap.BootstrapError, "BOOTSTRAP_INPUT_INVALID"):
            bootstrap.reconcile_opensearch(self.namespace, "short", FakeOpenSearch(), pause=lambda _: None)


if __name__ == "__main__": unittest.main()
