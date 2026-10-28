import importlib.util
import os
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("context_archive", Path(__file__).with_name("archive.py"))
packer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packer)


class ArchiveTests(unittest.TestCase):
    def test_spa_index_timestamp_survives_transport_for_cache_revalidation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "context"
            source.mkdir()
            index = source / "index.html"
            index.write_text("<main>release</main>")
            os.utime(index, (1700000000, 1700000000))
            packer.pack(source, root / "build.tar.gz")
            packer.unpack(root / "build.tar.gz", root / "unpacked")
            self.assertEqual((root / "unpacked/index.html").stat().st_mtime, 1700000000)

    def test_private_umask_does_not_hide_modules_in_nonroot_container(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            previous = os.umask(0o077)
            try:
                source = root / "context"
                (source / "payload/src/providers").mkdir(parents=True)
                (source / "payload/src/providers/provider.py").write_text("value = 1\n")
                packer.pack(source, root / "build.tar.gz")
                packer.unpack(root / "build.tar.gz", root / "unpacked")
                target = root / "unpacked/payload/src/providers"
                self.assertEqual(target.stat().st_mode & 0o777, 0o755)
                self.assertEqual((target / "provider.py").stat().st_mode & 0o777, 0o644)
            finally:
                os.umask(previous)

    def test_secret_env_cannot_enter_context_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "context"
            source.mkdir()
            (source / "voice.env").write_text("synthetic=value")
            with self.assertRaisesRegex(RuntimeError, "PRIVATE_FILE_IN_BUILD_CONTEXT"):
                packer.pack(source, root / "build.tar.gz")

    def test_symlink_cannot_escape_build_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "context"
            source.mkdir()
            (source / "linked").symlink_to(root)
            with self.assertRaisesRegex(RuntimeError, "UNSUPPORTED_ARCHIVE_ENTRY"):
                packer.pack(source, root / "build.tar.gz")

    def test_dangling_archive_target_is_not_followed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "context"
            source.mkdir()
            outside = root / "outside.tar.gz"
            target = root / "build.tar.gz"
            target.symlink_to(outside)
            with self.assertRaisesRegex(RuntimeError, "ARCHIVE_EXISTS"):
                packer.pack(source, target)
            self.assertFalse(outside.exists())


if __name__ == "__main__":
    unittest.main()
