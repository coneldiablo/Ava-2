"""Integration tests for private per-contour OpenSearch TLS material."""
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("onyx_search_config", ROOT / "native_modules/onyx/search_config.py")
search_config = importlib.util.module_from_spec(spec); sys.modules[spec.name] = search_config; spec.loader.exec_module(search_config)


class SearchConfigTests(unittest.TestCase):
    namespace = "ava_" + "7" * 32

    def test_generates_private_ca_node_admin_and_replays_exactly(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(search_config.os, "geteuid", return_value=0):
            owner = (os.getuid(), os.getgid())
            calls = []
            def run(command):
                calls.append(command)
                search_config._runner(command)
            first = search_config.ensure_search_config(directory, self.namespace, os.getgid(), run=run, owner=owner)
            root = Path(directory) / "search-config"
            snapshot = {name: (root / name).read_bytes() for name in first["files"]}
            second = search_config.ensure_search_config(directory, self.namespace, os.getgid(), run=run, owner=owner)
            self.assertEqual(first, second)
            self.assertEqual(snapshot, {name: (root / name).read_bytes() for name in second["files"]})
            self.assertEqual(stat.S_IMODE((root / "ca-key.pem").stat().st_mode), 0o400)
            self.assertEqual(stat.S_IMODE((root / "admin-key.pem").stat().st_mode), 0o440)
            self.assertEqual(stat.S_IMODE((root / "node-key.pem").stat().st_mode), 0o440)
            self.assertEqual(stat.S_IMODE((root / "admin.pem").stat().st_mode), 0o444)
            self.assertEqual(stat.S_IMODE((root / "ca.pem").stat().st_mode), 0o444)
            self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((root / "security").stat().st_mode), 0o750)
            self.assertEqual((root / "admin-key.pem").stat().st_gid, os.getgid())
            self.assertEqual((root / "node-key.pem").stat().st_gid, os.getgid())
            config = (root / "opensearch.yml").read_text()
            self.assertIn("plugins.security.allow_default_init_securityindex: false", config)
            self.assertIn("network.publish_host: search", config)
            self.assertIn("plugins.security.ssl.transport.enforce_hostname_verification: true", config)
            self.assertTrue(any("-purpose" in command and "sslserver" in command for command in calls))
            decoded = search_config.ssl._ssl._test_decode_cert(str(root / "node.pem"))
            self.assertIn(("DNS", "search"), decoded["subjectAltName"])
            for name in ('node', 'admin'):
                subject = subprocess.check_output(['openssl', 'x509', '-in', str(root / (name + '.pem')),
                                                  '-noout', '-subject', '-nameopt', 'RFC2253'], text=True).strip()
                canonical = subject.partition('=')[2].strip()
                self.assertTrue(canonical)
                self.assertIn("'" + canonical + "'", config)
            self.assertNotIn("admin_hash", (root / "security/internal_users.yml").read_text())

    def test_tamper_or_partial_state_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(search_config.os, "geteuid", return_value=0):
            owner = (os.getuid(), os.getgid())
            search_config.ensure_search_config(directory, self.namespace, os.getgid(), owner=owner)
            path = Path(directory) / "search-config/security/roles.yml"
            path.chmod(0o600)
            with self.assertRaisesRegex(search_config.SearchConfigError, "SEARCH_TLS_OWNERSHIP_CONFLICT"):
                search_config.ensure_search_config(directory, self.namespace, os.getgid(), owner=owner)
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(search_config.os, "geteuid", return_value=0):
            owner = (os.getuid(), os.getgid())
            search_config.ensure_search_config(directory, self.namespace, os.getgid(), owner=owner)
            (Path(directory) / "search-config/tls-claims.json").chmod(0o600)
            with self.assertRaisesRegex(search_config.SearchConfigError, "SEARCH_TLS_OWNERSHIP_CONFLICT"):
                search_config.ensure_search_config(directory, self.namespace, os.getgid(), owner=owner)
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(search_config.os, "geteuid", return_value=0):
            owner = (os.getuid(), os.getgid())
            search_config.ensure_search_config(directory, self.namespace, os.getgid(), owner=owner)
            (Path(directory) / "search-config/security").chmod(0o700)
            with self.assertRaisesRegex(search_config.SearchConfigError, "SEARCH_TLS_OWNERSHIP_CONFLICT"):
                search_config.ensure_search_config(directory, self.namespace, os.getgid(), owner=owner)
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(search_config.os, "geteuid", return_value=0):
            owner = (os.getuid(), os.getgid())
            search_config.ensure_search_config(directory, self.namespace, os.getgid(), owner=owner)
            (Path(directory) / "search-config/admin-key.pem").chmod(0o400)
            with self.assertRaisesRegex(search_config.SearchConfigError, "SEARCH_TLS_OWNERSHIP_CONFLICT"):
                search_config.ensure_search_config(directory, self.namespace, os.getgid(), owner=owner)
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(search_config.os, "geteuid", return_value=0):
            (Path(directory) / ".search-config-abandoned").mkdir()
            with self.assertRaisesRegex(search_config.SearchConfigError, "SEARCH_TLS_OWNERSHIP_CONFLICT"):
                search_config.ensure_search_config(directory, self.namespace, os.getgid(), owner=(os.getuid(), os.getgid()))

    def test_rejects_non_root_scope_and_bad_gid(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(search_config.os, "geteuid", return_value=501), self.assertRaisesRegex(search_config.SearchConfigError, "SEARCH_CONFIG_ROOT_REQUIRED"):
                search_config.ensure_search_config(directory, self.namespace, os.getgid())
            with mock.patch.object(search_config.os, "geteuid", return_value=0), self.assertRaisesRegex(search_config.SearchConfigError, "SEARCH_CONFIG_SCOPE_INVALID"):
                search_config.ensure_search_config(directory, "other", 0, owner=(os.getuid(), os.getgid()))


if __name__ == "__main__": unittest.main()
