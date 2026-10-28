"""Tests for the baked Onyx model-cache inventory."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import sys


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("inspect_onyx_model_cache", ROOT / "scripts/inspect-onyx-model-cache.py")
inspector = importlib.util.module_from_spec(spec); spec.loader.exec_module(inspector)


class OnyxModelCacheTests(unittest.TestCase):
    digest = "sha256:" + "a" * 64

    def cache(self, root: Path):
        model = root / "models--nomic-ai--nomic-embed-text-v1"
        revision = "b" * 40
        (model / "blobs").mkdir(parents=True)
        (model / "refs").mkdir()
        (model / "snapshots" / revision).mkdir(parents=True)
        blob = model / "blobs" / ("c" * 64)
        blob.write_bytes(b"weights")
        (model / "refs/main").write_text(revision)
        (model / "snapshots" / revision / "model.safetensors").symlink_to(blob)
        return model, blob

    def test_inventory_is_exact_and_hashes_resolved_inode_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); _model, blob = self.cache(root)
            (root / "CACHEDIR.TAG").write_text(
                "Signature: 8a477f597d28d172789f06886806bc55\n"
                "# This file is a cache directory tag created by huggingface_hub.\n"
                "# For information about cache directory tags, see:\n"
                "# http://www.brynosaurus.com/cachedir/\n"
            )
            lock = root / ".locks/models--nomic-ai--nomic-embed-text-v1"; lock.mkdir(parents=True)
            (lock / (("c" * 64) + ".lock")).touch()
            missing = root / "models--nomic-ai--nomic-embed-text-v1/.no_exist" / ("b" * 40)
            missing.mkdir(parents=True); (missing / "optional.json").touch()
            real_hash = inspector._hash_file
            calls = []
            def counted(path):
                calls.append(path.resolve())
                return real_hash(path)
            with mock.patch.object(inspector, "_hash_file", side_effect=counted):
                manifest = inspector.inspect_cache(root, self.digest)
            self.assertEqual(manifest["modelImageDigest"], self.digest)
            self.assertEqual(manifest["cacheRoot"], "/app/.cache/temp_huggingface/hub")
            self.assertEqual({item["path"].split("/")[1] for item in manifest["files"]}, {"blobs", "refs", "snapshots"})
            self.assertEqual(calls.count(blob.resolve()), 1)
            snapshot = next(item for item in manifest["files"] if "/snapshots/" in item["path"])
            self.assertEqual(snapshot["sha256"], real_hash(blob))
            self.assertEqual(snapshot["size"], len(b"weights"))
            self.assertFalse(any(".locks" in item["path"] or ".no_exist" in item["path"] for item in manifest["files"]))
            self.assertFalse(any(item["path"] == "CACHEDIR.TAG" for item in manifest["files"]))

    def test_rejects_escape_symlink_empty_file_and_malformed_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "hub"; root.mkdir()
            model, _blob = self.cache(root)
            outside = Path(directory) / "outside"; outside.write_bytes(b"foreign")
            link = next((model / "snapshots").glob("*")) / "escape.bin"
            link.symlink_to(outside)
            with self.assertRaisesRegex(inspector.InspectionError, "MODEL_CACHE_SYMLINK_INVALID"):
                inspector.inspect_cache(root, self.digest)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); model, _blob = self.cache(root)
            (model / "blobs" / ("d" * 64)).touch()
            with self.assertRaisesRegex(inspector.InspectionError, "MODEL_CACHE_FILE_EMPTY"):
                inspector.inspect_cache(root, self.digest)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); self.cache(root)
            (root / "unexpected").mkdir()
            with self.assertRaisesRegex(inspector.InspectionError, "MODEL_CACHE_PATH_INVALID"):
                inspector.inspect_cache(root, self.digest)

    def test_rejects_symlink_directory_bad_ref_and_mutable_image_name(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); model, _blob = self.cache(root)
            (model / "refs/main").write_text("not-a-revision")
            with self.assertRaisesRegex(inspector.InspectionError, "MODEL_CACHE_REFERENCE_INVALID"):
                inspector.inspect_cache(root, self.digest)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); model, _blob = self.cache(root)
            (model / "linked").symlink_to(model / "blobs", target_is_directory=True)
            with self.assertRaises(inspector.InspectionError):
                inspector.inspect_cache(root, self.digest)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); self.cache(root)
            with self.assertRaisesRegex(inspector.InspectionError, "MODEL_IMAGE_DIGEST_INVALID"):
                inspector.inspect_cache(root, "onyx/model:latest")

    def test_rejects_nonempty_or_linked_metadata_and_cli_reports_safe_code(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); self.cache(root)
            lock = root / ".locks/models--nomic-ai--nomic-embed-text-v1"; lock.mkdir(parents=True)
            (lock / (("c" * 64) + ".lock")).write_bytes(b"unexpected")
            with self.assertRaisesRegex(inspector.InspectionError, "MODEL_CACHE_METADATA_INVALID"):
                inspector.inspect_cache(root, self.digest)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); self.cache(root)
            lock = root / ".locks/models--nomic-ai--nomic-embed-text-v1"; lock.mkdir(parents=True)
            (lock / (("c" * 64) + ".lock")).symlink_to(root / "models--nomic-ai--nomic-embed-text-v1/refs/main")
            with self.assertRaisesRegex(inspector.InspectionError, "MODEL_CACHE_METADATA_INVALID"):
                inspector.inspect_cache(root, self.digest)
        with mock.patch.object(inspector, "CACHE_ROOT", Path("/definitely/missing")), \
             mock.patch.object(sys, "argv", ["inspect", "--image-digest", self.digest]), \
             self.assertRaises(SystemExit) as raised:
            inspector.entrypoint()
        self.assertEqual(str(raised.exception), "MODEL_CACHE_INVALID")
        self.assertNotIn("/definitely/missing", str(raised.exception))

    def test_cache_tag_requires_signature_and_ascii_comments(self):
        for content in (
            "Signature: wrong\n# comment\n",
            "Signature: 8a477f597d28d172789f06886806bc55\narbitrary data\n",
            "Signature: 8a477f597d28d172789f06886806bc55\n# non-ascii текст\n",
        ):
            with self.subTest(content=content), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); self.cache(root)
                (root / "CACHEDIR.TAG").write_text(content)
                with self.assertRaisesRegex(inspector.InspectionError, "MODEL_CACHE_TAG_INVALID"):
                    inspector.inspect_cache(root, self.digest)


if __name__ == "__main__": unittest.main()
