"""Focused unit tests for the fixed Onyx Community recipe renderer."""
import importlib.util
import hashlib
import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import module_deployment_helper
spec = importlib.util.spec_from_file_location("onyx_recipe_factory", ROOT / "scripts/onyx_recipe_factory.py")
factory = importlib.util.module_from_spec(spec); spec.loader.exec_module(factory)


class OnyxRecipeFactoryTests(unittest.TestCase):
    def fixture(self):
        deployment = str(uuid.uuid4())
        row = {"id": deployment, "businessId": 911001, "module": "onyx", "revision": 3,
               "hostname": f"qa-{deployment[:8]}-911001.knowledge.meludtech.tech", "namespace": "ava_" + deployment.replace("-", ""),
               "sourceCommit": factory.PINNED["onyx"], "reservedMemoryMiB": 12800}
        images = {"schemaVersion": 1, "sourceCommit": factory.PINNED["onyx"]}
        for index, key in enumerate(factory.IMAGE_KEYS): images[key] = f"registry.local/{key}@sha256:{'abcdef0123456789'[index] * 64}"
        images["modelCacheManifest"] = {
            "schemaVersion": 1, "sourceCommit": factory.PINNED["onyx"],
            "modelImageDigest": images["modelImage"].split("@")[-1],
            "cacheRoot": "/app/.cache/temp_huggingface/hub",
            "files": [
                {"path": "models--nomic-ai--nomic-embed-text-v1/refs/main", "sha256": "1" * 64, "size": 40},
                {"path": "models--nomic-ai--nomic-embed-text-v1/blobs/" + "3" * 64, "sha256": "3" * 64, "size": 274_000_000},
                {"path": "models--nomic-ai--nomic-embed-text-v1/snapshots/" + "2" * 40 + "/model.safetensors", "sha256": "1" * 64, "size": 274_000_000},
            ],
        }
        images["namespaceOverlayManifest"] = {
            "schemaVersion": 1, "sourceCommit": factory.PINNED["onyx"],
            "backendImageDigest": images["backendImage"].split("@")[-1],
            "files": {name: hashlib.sha256((ROOT / "native_modules/onyx" / name).read_bytes()).hexdigest()
                      for name in ("ava_namespace.py", "install_namespace.py")},
        }
        for key in factory.UID_KEYS: images[key] = os.getgid() if key.endswith("Gid") else 1001
        images.update({"backendUid": 1001, "backendGid": 1001, "modelUid": 1001, "modelGid": 1001,
                       "webUid": 1000, "webGid": 1000})
        keys = {name: chr(65 + index) * 43 for index, name in enumerate(factory.SECRET_NAMES)}
        keys['stateKey'] = '1234567890abcdef' * 4
        return row, images, keys

    def search_claims(self, row):
        names = [*factory.search_config.TLS_FILES, *factory.search_config._config_files(row["namespace"]).keys()]
        return {"schemaVersion": 1, "namespace": row["namespace"], "files": {name: hashlib.sha256(name.encode()).hexdigest() for name in names}}

    def knowledge_manifest(self, images):
        return {"schemaVersion": 1, "sourceCommit": factory.PINNED["onyx"], "backendImageDigest": images["backendImage"].split("@")[-1],
                "files": {name: hashlib.sha256((ROOT / "native_modules/onyx" / name).read_bytes()).hexdigest() for name in factory.KNOWLEDGE_OVERLAY_FILES}}

    def test_optional_native_knowledge_recipe_requires_exact_image_source_manifest_and_memory(self):
        row, images, keys = self.fixture()
        images["knowledgeOverlayManifest"] = self.knowledge_manifest(images)
        with self.assertRaisesRegex(factory.DeploymentError, "RESERVATION_TOO_SMALL"):
            factory.render(row, images, keys, tempfile.gettempdir(), self.search_claims(row))
        row["reservedMemoryMiB"] = 13824
        files, compose, recipe = factory.render(row, images, keys, tempfile.gettempdir(), self.search_claims(row))
        service = compose["services"]["knowledge-api"]
        self.assertNotIn("ports", service); self.assertEqual(service["networks"], ["native"])
        self.assertEqual(service["environment"]["AVA_AUTH_WORKER_KEY_FILE"], "/run/ava-keys/worker.key")
        self.assertIn("onyx.ava_auth.knowledge_app:app", service["command"])
        state = next(m for m in service["volumes"] if m["target"] == "/var/lib/ava-auth")
        self.assertTrue(state["read_only"])
        self.assertEqual(recipe["memoryMiB"], 13824)
        self.assertEqual(sum(s["mem_limit"] for s in compose["services"].values()), 13824 * 1024**2)
        with mock.patch.object(module_deployment_helper, "owned_path", side_effect=lambda p, **_kwargs: Path(p)):
            factory.validate_compose(compose, recipe, Path(tempfile.gettempdir()))
        for mutate in (lambda m: m.update(sourceCommit="0" * 40), lambda m: m.update(backendImageDigest="sha256:" + "0" * 64),
                       lambda m: m["files"].update({"auth/knowledge.py": "0" * 64}), lambda m: m["files"].update({"unknown.py": "0" * 64})):
            bad = json.loads(json.dumps(images)); mutate(bad["knowledgeOverlayManifest"])
            with self.assertRaisesRegex(factory.DeploymentError, "KNOWLEDGE_OVERLAY_REQUIRED"):
                factory.catalogue(bad)

    def test_complete_internal_retrieval_contour_is_scoped_and_secret_free(self):
        row, images, keys = self.fixture()
        files, compose, recipe = factory.render(row, images, keys, tempfile.gettempdir(), self.search_claims(row))
        self.assertEqual(set(compose["services"]), {"database", "cache", "search", "blob", "search_security_init", "search_bootstrap", "blob_bootstrap", "inference_model", "indexing_model", "api", "worker", "web", "auth", "gateway"})
        self.assertEqual(compose["networks"], {"native": {"internal": True},
                                               "ingress": {"external": True, "name": "ava-module-ingress"},
                                               "access": {"external": True, "name": "ava-module-access"}})
        self.assertEqual(recipe["imageDigest"], images["backendImage"].split("@")[-1])
        public = json.dumps([compose, recipe], sort_keys=True)
        for value in keys.values(): self.assertNotIn(value, public)
        self.assertIn("POSTGRES_DB=" + row["namespace"], files["native.env"][0])
        self.assertIn("DB_READONLY_USER=" + row["namespace"] + "_ro", files["native.env"][0])
        self.assertIn("DB_READONLY_PASSWORD=" + keys["dbReadonly"], files["native.env"][0])
        self.assertIn("CREATE ROLE " + row["namespace"] + "_ro LOGIN PASSWORD", files["seed.sql"][0])
        self.assertIn("CREATE EXTENSION IF NOT EXISTS pgcrypto", files["seed.sql"][0])
        self.assertIn("CREATE EXTENSION IF NOT EXISTS pg_trgm", files["seed.sql"][0])
        self.assertIn("S3_FILE_STORE_BUCKET_NAME=" + row["namespace"].replace("_", "-") + "-files", files["native.env"][0])
        self.assertIn("OPENSEARCH_HOST=search", files["native.env"][0])
        self.assertIn("OPENSEARCH_VERIFY_CERTS=true", files["native.env"][0])
        self.assertIn("OPENSEARCH_CA_CERTS=/run/ava-search-ca/ca.pem", files["native.env"][0])
        self.assertIn("AVA_DEPLOYMENT_REVISION=" + str(row["revision"]), files["native.env"][0])
        self.assertIn("HF_HUB_OFFLINE", json.dumps(compose["services"]["inference_model"]))
        self.assertEqual(compose["services"]["api"]["depends_on"]["inference_model"], {"condition": "service_healthy"})
        self.assertIn("/api/health", json.dumps(compose["services"]["inference_model"]["healthcheck"]))
        self.assertIn("/ava-native-healthz", json.dumps(compose["services"]["api"]["healthcheck"]))
        self.assertNotIn("AVA_NATIVE_HTTP_GUARD", files["native.env"][0])
        self.assertEqual(compose["services"]["api"]["environment"]["AVA_NATIVE_HTTP_GUARD"], "true")
        self.assertEqual(compose["services"]["worker"]["environment"], {"AVA_NATIVE_HTTP_GUARD": "false"})
        web = compose["services"]["web"]
        self.assertEqual(web["environment"]["OVERRIDE_API_PRODUCTION"], "true")
        self.assertEqual(web["environment"]["INTERNAL_URL"], "http://api:8080")
        self.assertNotIn("ports", web)
        self.assertEqual(web["networks"], ["native"])
        self.assertNotIn("AVA_NATIVE_QA", files["native.env"][0])
        self.assertNotIn("qa-documents.py", files)
        for service in compose["services"].values():
            self.assertNotIn("qa_documents", json.dumps(service))
            self.assertNotIn("qa-documents", json.dumps(service))
        self.assertEqual(files['state.key'], (keys['stateKey'], 0o440, images['backendGid']))
        self.assertRegex(files['state.key'][0], r'^[a-f0-9]{64}$')
        self.assertEqual(files['gateway.key'][1:], (0o440, images['backendGid']))
        self.assertEqual(files['native-peer.key'], (keys['gatewayPeer'], 0o440, images['webGid']))
        self.assertEqual(files['broker-peer.key'], (keys['brokerPeer'], 0o640, images['webGid']))
        self.assertEqual(files['gateway-encryption.key'], (keys['gatewayEncryption'], 0o640, images['webGid']))
        self.assertEqual(compose["services"]["search"]["environment"]["OPENSEARCH_TMPDIR"], "/run/ava-jni")
        self.assertIn(f"/run/ava-jni:rw,nosuid,nodev,exec,uid={images['searchUid']},gid={images['searchGid']},mode=0700,size=64m", compose["services"]["search"]["tmpfs"])
        self.assertIn("/app/.cache/temp_huggingface", [mount["target"] for mount in compose["services"]["inference_model"]["volumes"]])
        self.assertIn(f"/usr/share/opensearch/logs:rw,nosuid,nodev,uid={images['searchUid']},gid={images['searchGid']},mode=0750,size=128m", compose["services"]["search"]["tmpfs"])
        self.assertIn(f"/var/run/postgresql:rw,nosuid,nodev,uid={images['postgresUid']},gid={images['postgresGid']},size=8m", compose["services"]["database"]["tmpfs"])
        self.assertNotIn(keys["blobRootSecret"], files["native.env"][0])
        self.assertIn(keys["blobRootSecret"], files["mc-config.json"][0])
        self.assertNotIn(keys["blobRuntimeSecret"], files["minio-bootstrap.sh"][0])
        self.assertNotIn(keys["searchRuntime"], files["opensearch-bootstrap.env"][0])
        self.assertEqual(files["opensearch-runtime-password"], (keys["searchRuntime"] + "\n", 0o400, 0))
        self.assertEqual(compose["services"]["search_bootstrap"]["restart"], "no")
        self.assertNotIn("-nhnv", files["run-securityadmin.sh"][0])
        self.assertIn("-arc", files["run-securityadmin.sh"][0])
        self.assertEqual(compose["services"]["search_security_init"]["environment"]["JAVA_OPTS"], "-Xms64m -Xmx128m -Djava.io.tmpdir=/run/ava-jni")
        search_mounts = {mount['target']: mount for mount in compose['services']['search']['volumes']}
        self.assertEqual(search_mounts['/usr/share/opensearch/config']['source'], 'search_config')
        self.assertTrue(search_mounts['/usr/share/opensearch/config/opensearch.yml']['read_only'])
        self.assertTrue(search_mounts['/usr/share/opensearch/config/ava-tls/node-key.pem']['read_only'])
        self.assertGreaterEqual(compose["services"]["search_security_init"]["mem_limit"], 256 * 1024**2)
        self.assertEqual(compose['services']['search_security_init']['user'], f"{images['searchUid']}:{images['searchGid']}")
        self.assertEqual(files['run-securityadmin.sh'][1:], (0o440, images['searchGid']))
        self.assertGreaterEqual(compose['services']['blob_bootstrap']['mem_limit'], 128 * 1024**2)
        self.assertGreaterEqual(compose["services"]["search_bootstrap"]["mem_limit"], 128 * 1024**2)
        self.assertEqual(compose["services"]["blob_bootstrap"]["environment"]["MC_CONFIG_DIR"], "/tmp/mc")
        self.assertIn("/run/ava-search-ca/ca.pem", [mount["target"] for mount in compose["services"]["search_bootstrap"]["volumes"]])
        self.assertEqual(compose["services"]["api"]["depends_on"]["search_bootstrap"], {"condition": "service_completed_successfully"})
        self.assertEqual(recipe["initServices"], ["search_security_init", "search_bootstrap", "blob_bootstrap"])
        self.assertEqual(set(recipe), {"deploymentId", "businessId", "module", "revision", "hostname", "namespace", "sourceCommit", "schemaVersion", "memoryMiB", "imageDigest", "composeSha256", "initServices"})
        self.assertNotIn("plugins.security.disabled", files["search.env"][0])
        self.assertEqual(sum(item["mem_limit"] for item in compose["services"].values()), 12800 * 1024**2)
        for service in compose["services"].values():
            self.assertNotIn("ports", service); self.assertTrue(service["read_only"]); self.assertEqual(service["cap_drop"], ["ALL"])
            self.assertEqual(service["security_opt"], ["no-new-privileges:true"])

    def test_auth_gateway_enrollment_and_secret_boundaries_are_stable(self):
        row, images, keys = self.fixture()
        files, compose, recipe = factory.render(row, images, keys, tempfile.gettempdir(), self.search_claims(row))
        enrollment = json.loads(files["enrollment.json"][0])
        self.assertEqual(set(enrollment), {"schemaVersion", "deploymentId", "businessId", "module", "revision",
                                           "hostname", "namespace", "sourceCommit", "adapterId", "nativeScope"})
        self.assertEqual(enrollment["adapterId"], row["id"])
        self.assertEqual(enrollment["nativeScope"], row["namespace"])
        self.assertEqual(files["enrollment.json"][1:], (0o400, 0))
        gateway_config = json.loads(files["gateway.json"][0])
        self.assertEqual(gateway_config, {
            "businessId": row["businessId"], "module": "onyx", "deploymentId": row["id"],
            "revision": row["revision"], "adapterId": row["id"], "nativeScope": row["namespace"],
            "publicOrigin": "https://" + row["hostname"], "avaOrigin": "https://wh.meludtech.tech",
            "brokerOrigin": "http://ava-module-access:3901", "nativeOrigin": "http://auth:4011",
            "upstreamOrigin": "http://web:3000",
        })
        self.assertEqual(files["gateway.json"][1:], (0o440, images["webGid"]))
        auth = compose["services"]["auth"]
        self.assertEqual(auth["command"], ["uvicorn", "onyx.ava_auth.app:app", "--host", "0.0.0.0", "--port", "4011", "--no-access-log"])
        self.assertEqual(auth["networks"], ["native"])
        self.assertEqual(auth["env_file"], [str(Path(tempfile.gettempdir()) / "config/auth.env")])
        auth_env = dict(line.split("=", 1) for line in files["auth.env"][0].splitlines())
        self.assertEqual(set(auth_env), {
            "AVA_DEPLOYMENT_NAMESPACE", "AVA_BUSINESS_ID", "AVA_DEPLOYMENT_ID", "AVA_DEPLOYMENT_REVISION",
            "POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD",
            "REDIS_HOST", "REDIS_PORT", "REDIS_PASSWORD", "AUTH_TYPE", "AUTH_BACKEND", "MULTI_TENANT",
            "USER_AUTH_SECRET", "SESSION_EXPIRE_TIME_SECONDS",
            "DISABLE_TELEMETRY", "ENABLE_PAID_ENTERPRISE_EDITION_FEATURES", "LOG_LEVEL",
            "S3_FILE_STORE_BUCKET_NAME",
        })
        self.assertEqual(auth_env['DISABLE_TELEMETRY'], 'true')
        self.assertEqual(auth_env['ENABLE_PAID_ENTERPRISE_EDITION_FEATURES'], 'false')
        self.assertEqual(auth_env['LOG_LEVEL'], 'error')
        self.assertEqual(files["auth.env"][1:], (0o600, images["backendGid"]))
        from native_modules.onyx.ava_namespace import validate_runtime_storage
        validate_runtime_storage(auth_env)
        self.assertEqual(auth_env['S3_FILE_STORE_BUCKET_NAME'], row['namespace'].replace('_', '-') + '-files')
        for forbidden in ("OPENSEARCH", "S3_AWS", "S3_ENDPOINT", "MODEL_SERVER", "DB_READONLY", "FILE_STORE_BACKEND"):
            self.assertNotIn(forbidden, files["auth.env"][0])
        self.assertIn("/v1/sessions/create", json.dumps(auth["healthcheck"]))
        self.assertIn("e.code==403", json.dumps(auth["healthcheck"]))
        gateway = compose["services"]["gateway"]
        self.assertEqual(gateway["image"], images["gatewayImage"])
        self.assertEqual(gateway["networks"], ["native", "ingress", "access"])
        self.assertEqual(gateway["depends_on"]["auth"], {"condition": "service_healthy"})
        mounts = lambda name: {item["target"]: item for item in compose["services"][name].get("volumes", [])}
        api_mounts, auth_mounts, worker_mounts, web_mounts, gateway_mounts = map(mounts, ("api", "auth", "worker", "web", "gateway"))
        for name, value in auth["environment"].items():
            if name.endswith("_FILE"):
                covered = value in auth_mounts or any(
                    mount["type"] == "volume" and Path(value).is_relative_to(target)
                    for target, mount in auth_mounts.items()
                )
                self.assertTrue(covered, name)
        self.assertEqual(set(path for path in api_mounts if path.startswith("/run/ava-keys/")),
                         {"/run/ava-keys/gateway.key", "/run/ava-keys/state.key"})
        self.assertEqual(set(path for path in auth_mounts if path.startswith("/run/ava-keys/")),
                         {"/run/ava-keys/gateway.key", "/run/ava-keys/worker.key", "/run/ava-keys/state.key"})
        self.assertNotIn("/run/ava-keys/worker.key", api_mounts)
        self.assertNotIn("/var/lib/ava-auth", worker_mounts)
        self.assertFalse(any(path.startswith("/run/ava-keys/") for path in worker_mounts))
        self.assertFalse(any(path.startswith("/run/ava") for path in web_mounts))
        self.assertEqual(gateway_mounts["/run/ava/secrets/native-peer"]["source"], str(Path(tempfile.gettempdir()) / "config/native-peer.key"))
        self.assertEqual(recipe["memoryMiB"], 12800)

    def test_model_egress_fails_closed_without_prepared_cache_or_mutable_image(self):
        row, images, keys = self.fixture()
        bad_manifest = {**images, "modelCacheManifest": {**images["modelCacheManifest"], "files": []}}
        wrong_digest = {**images, "modelCacheManifest": {**images["modelCacheManifest"], "modelImageDigest": "sha256:" + "9" * 64}}
        for bad in (bad_manifest, wrong_digest, {**images, "backendImage": "repo/onyx:latest"},
                    {**images, "gatewayImage": "ava-gateway:latest"},
                    {**row, "hostname": "qa-911002.knowledge.meludtech.tech"}, {**row, "reservedMemoryMiB": 12799}):
            with self.subTest(bad=bad):
                with self.assertRaises(factory.DeploymentError):
                    current_row = bad if "id" in bad else row
                    factory.render(current_row, images if "id" in bad else bad, keys, tempfile.gettempdir(), self.search_claims(current_row))

    def test_root_owned_local_image_ids_are_accepted_and_manifests_stay_tied(self):
        row, images, keys = self.fixture()
        images["backendImage"] = "sha256:" + "a" * 64
        images["modelImage"] = "sha256:" + "b" * 64
        images["namespaceOverlayManifest"]["backendImageDigest"] = images["backendImage"]
        images["modelCacheManifest"]["modelImageDigest"] = images["modelImage"]
        _files, compose, recipe = factory.render(row, images, keys, tempfile.gettempdir(), self.search_claims(row))
        self.assertEqual(compose["services"]["api"]["image"], images["backendImage"])
        self.assertEqual(recipe["imageDigest"], images["backendImage"])
        wrong = {**images, "modelCacheManifest": {**images["modelCacheManifest"], "modelImageDigest": "sha256:" + "c" * 64}}
        with self.assertRaisesRegex(factory.DeploymentError, "DEPLOYMENT_MODEL_CACHE_REQUIRED"):
            factory.render(row, wrong, keys, tempfile.gettempdir(), self.search_claims(row))

    def test_output_passes_helper_validation(self):
        row, images, keys = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            _, compose, recipe = factory.render(row, images, keys, directory, self.search_claims(row))
            with mock.patch.object(module_deployment_helper, "owned_path", side_effect=lambda path, **_: Path(path)):
                factory.validate_compose(compose, recipe, Path(directory))

    def test_prepare_writes_bootstrap_and_replays_only_identical_owned_files(self):
        row, images, keys = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            recipes, catalogue = Path(directory) / "recipes", Path(directory) / "catalogue.json"
            recipes.mkdir(); catalogue.write_text("{}")
            subject = factory.OnyxRecipeFactory(recipes, catalogue)
            generated = iter(keys[name] for name in factory.SECRET_NAMES if name != "stateKey")
            def load(path):
                if Path(path) == catalogue:
                    return b"{}", images
                raw = Path(path).read_bytes()
                return raw, json.loads(raw)
            def write(path, content, mode=0o600, gid=0):
                path = Path(path)
                if path.exists():
                    self.assertEqual(path.read_bytes(), content)
                    self.assertEqual(path.stat().st_mode & 0o777, mode)
                    return
                path.write_bytes(content)
                path.chmod(mode)
            with mock.patch.object(factory.os, "geteuid", return_value=0), \
                 mock.patch.object(factory, "owned_path", side_effect=lambda path, **_: Path(path)), \
                 mock.patch.object(module_deployment_helper, "owned_path", side_effect=lambda path, **_: Path(path)), \
                 mock.patch.object(factory, "private_json", side_effect=load), \
                 mock.patch.object(factory.secrets, "token_urlsafe", side_effect=lambda _n: next(generated)), \
                 mock.patch.object(factory.secrets, "token_hex", return_value=keys['stateKey']), \
                 mock.patch.object(factory.search_config, "ensure_search_config", return_value=self.search_claims(row)), \
                 mock.patch.object(subject, "_write", side_effect=write):
                subject.prepare(row)
                subject.prepare(row)
            root = recipes / row["id"]
            self.assertTrue((root / "config/minio-bootstrap.sh").exists())
            self.assertTrue((root / "config/dependency-bootstrap.py").exists())
            compose = json.loads((root / "compose.json").read_text())
            native = (root / "config/native.env").read_text()
            self.assertNotIn(keys["blobRootAccess"], native)
            self.assertEqual(compose["services"]["blob_bootstrap"]["image"], images["blobClientImage"])


if __name__ == "__main__": unittest.main()
