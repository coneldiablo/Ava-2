"""Unit tests for the root-only Onyx QA image catalogue attestor."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location(
    "prepare_onyx_qa_catalogue", ROOT / "scripts/prepare-onyx-qa-catalogue.py"
)
catalogue_qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalogue_qa)

DIGEST_A = "sha256:" + "a" * 64
DIGEST_B = "sha256:" + "b" * 64
BLOB_REVISION = "9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a"
CLIENT_REVISION = "7394ce0dd2a80935aded936b09fa12cbb3cb8096"


def model_cache():
    return {
        "schemaVersion": 1,
        "sourceCommit": catalogue_qa.helper.PINNED["onyx"],
        "modelImageDigest": catalogue_qa.PINNED_IMAGES["modelImage"],
        "cacheRoot": "/app/.cache/temp_huggingface/hub",
        "files": [
            {"path": "models--ava--qa/blobs/" + "1" * 64, "sha256": "2" * 64, "size": 1},
            {"path": "models--ava--qa/refs/main", "sha256": "3" * 64, "size": 1},
            {"path": "models--ava--qa/snapshots/" + "4" * 40 + "/config.json", "sha256": "5" * 64, "size": 1},
        ],
    }


class OnyxQaCatalogueTests(unittest.TestCase):
    def test_rejects_non_root_foreign_or_invalid_directory_before_image_access(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = root / "acceptance"
            base.mkdir(mode=0o700)
            good = base / "onyx-recipe-qa-one"
            good.mkdir(mode=0o700)
            foreign = root / "onyx-recipe-qa-foreign"
            foreign.mkdir(mode=0o700)
            invalid = base / "other"
            invalid.mkdir(mode=0o700)
            with mock.patch.object(catalogue_qa, "BASE", base), \
                 mock.patch.object(catalogue_qa, "installed", side_effect=AssertionError("image access")):
                with mock.patch.object(catalogue_qa.os, "geteuid", return_value=1001):
                    with self.assertRaisesRegex(ValueError, "QA_DIRECTORY_REQUIRED"):
                        catalogue_qa.prepare(good, DIGEST_A, DIGEST_B)
                with mock.patch.object(catalogue_qa.os, "geteuid", return_value=0):
                    for directory in (foreign, invalid):
                        with self.subTest(directory=directory), self.assertRaisesRegex(ValueError, "QA_DIRECTORY_REQUIRED"):
                            catalogue_qa.prepare(directory, DIGEST_A, DIGEST_B)

    def test_rejects_foreign_ownership_non_private_and_non_empty_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            with mock.patch.object(catalogue_qa, "BASE", base), \
                 mock.patch.object(catalogue_qa.os, "geteuid", return_value=0), \
                 mock.patch.object(catalogue_qa, "installed", side_effect=AssertionError("image access")):
                foreign = base / "onyx-recipe-qa-foreign"
                foreign.mkdir(mode=0o700)
                with mock.patch.object(catalogue_qa.helper, "owned_path", side_effect=ValueError("DEPLOYMENT_RECIPE_UNTRUSTED")):
                    with self.assertRaisesRegex(ValueError, "DEPLOYMENT_RECIPE_UNTRUSTED"):
                        catalogue_qa.prepare(foreign, DIGEST_A, DIGEST_B)

                public = base / "onyx-recipe-qa-public"
                public.mkdir(mode=0o755)
                nonempty = base / "onyx-recipe-qa-nonempty"
                nonempty.mkdir(mode=0o700)
                (nonempty / "unexpected").write_text("foreign", encoding="utf-8")
                with mock.patch.object(catalogue_qa.helper, "owned_path", side_effect=lambda path, **_: Path(path)):
                    for directory in (public, nonempty):
                        with self.subTest(directory=directory), self.assertRaisesRegex(ValueError, "QA_EMPTY_PRIVATE_DIRECTORY_REQUIRED"):
                            catalogue_qa.prepare(directory, DIGEST_A, DIGEST_B)

    def test_installed_rejects_mutable_missing_or_foreign_image(self):
        with mock.patch.object(catalogue_qa.helper, "run", side_effect=AssertionError("inspect must not run")):
            with self.assertRaisesRegex(ValueError, "QA_IMAGE_DIGEST_REQUIRED"):
                catalogue_qa.installed("minio/minio:latest")
        for rows in ([], [{"Id": DIGEST_B, "Config": {}}], [{"Id": DIGEST_A}, {"Id": DIGEST_A}]):
            with self.subTest(rows=rows), mock.patch.object(catalogue_qa.helper, "run", return_value=json.dumps(rows)):
                with self.assertRaisesRegex(ValueError, "QA_IMAGE_NOT_INSTALLED"):
                    catalogue_qa.installed(DIGEST_A)

    def test_installed_rejects_wrong_runtime_user_or_source_revision(self):
        base = {"Id": DIGEST_A, "Config": {"User": "1001:1001", "Labels": {"org.opencontainers.image.revision": BLOB_REVISION}}}
        cases = [
            ({**base, "Config": {**base["Config"], "User": "0:0"}}, "1001:1001", BLOB_REVISION, "QA_IMAGE_USER_INVALID"),
            ({**base, "Config": {**base["Config"], "Labels": {"org.opencontainers.image.revision": CLIENT_REVISION}}}, "1001:1001", BLOB_REVISION, "QA_IMAGE_SOURCE_INVALID"),
        ]
        for row, user, revision, code in cases:
            with self.subTest(code=code), mock.patch.object(catalogue_qa.helper, "run", return_value=json.dumps([row])):
                with self.assertRaisesRegex(ValueError, code):
                    catalogue_qa.installed(DIGEST_A, user, revision)

    def _fixture(self, temporary):
        base = Path(temporary)
        directory = base / "onyx-recipe-qa-safe"
        directory.mkdir(mode=0o700)
        cache_file = base / "onyx-full-build-r1" / "model-cache-manifest.json"
        cache_file.parent.mkdir(mode=0o700)
        raw = json.dumps(model_cache(), sort_keys=True, separators=(",", ":")).encode()
        cache_file.write_bytes(raw)
        cache_file.chmod(0o600)
        namespace_hash = hashlib.sha256((catalogue_qa.SOURCE / "native_modules/onyx/ava_namespace.py").read_bytes()).hexdigest()
        core_hash = hashlib.sha256((catalogue_qa.SOURCE / "native_modules/onyx/auth/core.py").read_bytes()).hexdigest()
        app_hash = hashlib.sha256((catalogue_qa.SOURCE / "native_modules/onyx/auth/app.py").read_bytes()).hexdigest()
        return base, directory, raw, namespace_hash, core_hash, app_hash

    def _patches(self, base, raw, namespace_hash, core_hash=None, app_hash=None, state_dir_valid=True):
        if core_hash is None:
            core_hash = hashlib.sha256((catalogue_qa.SOURCE / "native_modules/onyx/auth/core.py").read_bytes()).hexdigest()
        if app_hash is None:
            app_hash = hashlib.sha256((catalogue_qa.SOURCE / "native_modules/onyx/auth/app.py").read_bytes()).hexdigest()
        return (
            mock.patch.object(catalogue_qa, "BASE", base),
            mock.patch.object(catalogue_qa, "CACHE_SHA256", hashlib.sha256(raw).hexdigest()),
            mock.patch.object(catalogue_qa.os, "geteuid", return_value=0),
            mock.patch.object(catalogue_qa.helper, "owned_path", side_effect=lambda path, **_: Path(path)),
            mock.patch.object(catalogue_qa, "installed"),
            mock.patch.object(catalogue_qa.helper, "run", return_value=json.dumps({
                "namespace": namespace_hash, "core_hash": core_hash, "app_hash": app_hash,
                "state_dir_valid": state_dir_valid, "tokenizer_loaded_offline": True, "token_count": 8
            })),
        )

    def test_rejects_model_cache_attestation_hash_mismatch_before_container_probe(self):
        with tempfile.TemporaryDirectory() as temporary:
            base, directory, _, _, _, _ = self._fixture(temporary)
            with mock.patch.object(catalogue_qa, "BASE", base), \
                 mock.patch.object(catalogue_qa.os, "geteuid", return_value=0), \
                 mock.patch.object(catalogue_qa.helper, "owned_path", side_effect=lambda path, **_: Path(path)), \
                 mock.patch.object(catalogue_qa, "installed"), \
                 mock.patch.object(catalogue_qa.helper, "run", side_effect=AssertionError("container probe")):
                with self.assertRaisesRegex(ValueError, "QA_MODEL_CACHE_ATTESTATION_CHANGED"):
                    catalogue_qa.prepare(directory, DIGEST_A, DIGEST_B)

    def test_rejects_namespace_hash_from_actual_backend_image_when_it_differs(self):
        with tempfile.TemporaryDirectory() as temporary:
            base, directory, raw, namespace_hash, _, _ = self._fixture(temporary)
            patches = self._patches(base, raw, "0" * 64)
            with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
                with self.assertRaisesRegex(ValueError, "QA_NAMESPACE_SOURCE_MISMATCH"):
                    catalogue_qa.prepare(directory, DIGEST_A, DIGEST_B)
            self.assertNotEqual(namespace_hash, "0" * 64)

    def test_rejects_core_hash_from_actual_backend_image_when_it_differs(self):
        with tempfile.TemporaryDirectory() as temporary:
            base, directory, raw, namespace_hash, core_hash, _ = self._fixture(temporary)
            patches = self._patches(base, raw, namespace_hash, core_hash="0" * 64)
            with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
                with self.assertRaisesRegex(ValueError, "QA_AUTH_CORE_SOURCE_MISMATCH"):
                    catalogue_qa.prepare(directory, DIGEST_A, DIGEST_B)
            self.assertNotEqual(core_hash, "0" * 64)

    def test_rejects_app_hash_from_actual_backend_image_when_it_differs(self):
        with tempfile.TemporaryDirectory() as temporary:
            base, directory, raw, namespace_hash, _, app_hash = self._fixture(temporary)
            patches = self._patches(base, raw, namespace_hash, app_hash="0" * 64)
            with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
                with self.assertRaisesRegex(ValueError, "QA_AUTH_APP_SOURCE_MISMATCH"):
                    catalogue_qa.prepare(directory, DIGEST_A, DIGEST_B)
            self.assertNotEqual(app_hash, "0" * 64)

    def test_rejects_state_dir_when_invalid(self):
        with tempfile.TemporaryDirectory() as temporary:
            base, directory, raw, namespace_hash, _, _ = self._fixture(temporary)
            patches = self._patches(base, raw, namespace_hash, state_dir_valid=False)
            with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
                with self.assertRaisesRegex(ValueError, "QA_STATE_DIRECTORY_INVALID"):
                    catalogue_qa.prepare(directory, DIGEST_A, DIGEST_B)

    def test_writes_valid_private_catalogue_without_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            base, directory, raw, namespace_hash, _, _ = self._fixture(temporary)
            patches = self._patches(base, raw, namespace_hash)
            with patches[0], patches[1], patches[2], patches[3], patches[4] as installed, patches[5] as run:
                result = catalogue_qa.prepare(directory, DIGEST_A, DIGEST_B)

            output = directory / "catalogue.json"
            value = json.loads(output.read_text(encoding="utf-8"))
            catalogue_qa.catalogue(value)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertTrue(result["qa_only"])
            self.assertFalse(result["buyer_acceptance"])
            self.assertEqual(result["catalogue_sha256"], hashlib.sha256(output.read_bytes()).hexdigest())
            serialized = json.dumps({"result": result, "catalogue": value}, sort_keys=True).lower()
            for forbidden in ("password", "credential", "rootaccess", "rootsecret", "runtimeSecret".lower()):
                self.assertNotIn(forbidden, serialized)

            self.assertEqual(installed.call_count, len(catalogue_qa.PINNED_IMAGES) + 5)
            installed.assert_any_call(catalogue_qa.PINNED_IMAGES["gatewayImage"], "node")
            installed.assert_any_call(DIGEST_A, "1001:1001", BLOB_REVISION)
            installed.assert_any_call(DIGEST_B, "0:0", CLIENT_REVISION)
            command = run.call_args.args[0]
            self.assertEqual(command[:8], ["docker", "run", "--rm", "--network", "none", "--read-only", "--memory", "256m"])
            self.assertIn("--cap-drop", command)
            self.assertIn("no-new-privileges", command)
            self.assertNotIn(DIGEST_A, command)
            self.assertNotIn(DIGEST_B, command)
            command_text = json.dumps(command).lower()
            for forbidden in ("password", "credential", "secret", "access_key"):
                self.assertNotIn(forbidden, command_text)


if __name__ == "__main__":
    unittest.main()
