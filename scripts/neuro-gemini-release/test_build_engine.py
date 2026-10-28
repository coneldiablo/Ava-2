import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("engine_bundle", Path(__file__).with_name("build_engine.py"))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
BASE, CANDIDATE = "a" * 40, "b" * 40


class SourceFenceTests(unittest.TestCase):
    def fake_git(self, repo, *args, optional=False):
        if args[0] == "merge-base":
            return b""
        if args[0] == "diff":
            return b"M\0src/existing.py\0A\0src/new.py\0"
        if args[0] == "ls-tree":
            ref, path = args[2], args[-1]
            if ref == BASE and path == "src/new.py":
                return b""
            oid = b"c" * 40 if ref == BASE else b"d" * 40
            return b"100644 blob " + oid + b"\t" + path.encode() + b"\0"
        if args == ("cat-file", "blob", "c" * 40):
            return b"old"
        return b"candidate"

    def test_preserves_unselected_production_overlay(self):
        inventory = {"src/existing.py": builder.digest(b"old"), "src/onyx_client.py": "production-overlay"}
        with patch.object(builder, "git", self.fake_git):
            payload, fences = builder.selected_payload(Path("."), BASE, CANDIDATE, inventory)
        self.assertEqual(set(payload), {"src/existing.py", "src/new.py"})
        self.assertNotIn("src/onyx_client.py", payload)
        self.assertIsNone(fences["src/new.py"])

    def test_changed_base_bytes_rejected(self):
        with patch.object(builder, "git", self.fake_git), self.assertRaisesRegex(RuntimeError, "PRODUCTION_SOURCE_DRIFT"):
            builder.selected_payload(Path("."), BASE, CANDIDATE, {"src/existing.py": "different"})

    def test_new_path_already_in_production_rejected(self):
        inventory = {"src/existing.py": builder.digest(b"old"), "src/new.py": "unexpected"}
        with patch.object(builder, "git", self.fake_git), self.assertRaisesRegex(RuntimeError, "PRODUCTION_SOURCE_DRIFT"):
            builder.selected_payload(Path("."), BASE, CANDIDATE, inventory)

    def test_delete_rejected(self):
        def fake(repo, *args, optional=False):
            return b"D\0src/existing.py\0" if args[0] == "diff" else b""
        with patch.object(builder, "git", fake), self.assertRaisesRegex(RuntimeError, "DELETION_OR_TYPE_CHANGE"):
            builder.selected_payload(Path("."), BASE, CANDIDATE, {})

    def test_unpinned_commit_rejected_before_git(self):
        with patch.object(builder, "git") as run, self.assertRaisesRegex(RuntimeError, "CANDIDATE_SHA_REQUIRED"):
            builder.selected_payload(Path("."), BASE, "HEAD", {})
        run.assert_not_called()

    def test_git_symlink_is_not_treated_as_python_source(self):
        def fake(repo, *args, optional=False):
            if args[0] == "ls-tree":
                return b"120000 blob " + b"e" * 40 + b"\tsrc/new.py\0"
            return self.fake_git(repo, *args, optional=optional)
        with patch.object(builder, "git", fake), self.assertRaisesRegex(RuntimeError, "REGULAR_GIT_BLOB_REQUIRED"):
            builder.regular_blob(Path("."), CANDIDATE, "src/new.py")


if __name__ == "__main__":
    unittest.main()
