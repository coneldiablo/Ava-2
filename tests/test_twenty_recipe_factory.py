"""Pure unit tests for the fixed Twenty recipe renderer; no Docker or root writes."""
import importlib.util
import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import module_deployment_helper
spec = importlib.util.spec_from_file_location("twenty_recipe_factory", ROOT / "scripts/twenty_recipe_factory.py")
factory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(factory)


class TwentyRecipeFactoryUnitTests(unittest.TestCase):
    def fixture(self):
        deployment = str(uuid.uuid4())
        row = {"id": deployment, "businessId": 731, "module": "twenty", "revision": 4,
               "hostname": f"qa-{deployment[:8]}-731.crm.meludtech.tech",
               "namespace": "ava_" + deployment.replace("-", ""),
               "sourceCommit": factory.PINNED["twenty"], "reservedMemoryMiB": 4096}
        digest = "sha256:" + "a" * 64
        images = {"schemaVersion": 1, "sourceCommit": factory.PINNED["twenty"],
                  "nativeImage": digest, "postgresImage": "sha256:" + "b" * 64,
                  "redisImage": "sha256:" + "c" * 64, "postgresUid": 999, "postgresGid": 999,
                  "redisUid": 999, "redisGid": 999}
        keys = {name: (chr(65 + index) * 43) for index, name in enumerate(factory.SECRET_NAMES)}
        return row, images, keys

    def test_render_is_deterministic_scoped_and_keeps_secrets_in_private_files(self):
        row, images, keys = self.fixture()
        with tempfile.TemporaryDirectory() as tmp:
            first = factory.render(row, images, keys, tmp)
            second = factory.render(row, images, keys, tmp)
            self.assertEqual(first, second)
            files, compose, recipe = first
            serialized = json.dumps([compose, recipe], sort_keys=True)
            for value in keys.values():
                self.assertNotIn(value, serialized)
            self.assertIn(keys["dbAdmin"], files["database.env"][0])
            self.assertIn(keys["dbApp"], files["native.env"][0])
            self.assertLessEqual(sum(service["mem_limit"] for service in compose["services"].values()), 4096 * 1024**2)
            self.assertEqual(set(compose["services"]), {"database", "cache", "initializer", "native", "worker"})
            for name, service in compose["services"].items():
                self.assertNotIn("ports", service); self.assertEqual(service["cap_drop"], ["ALL"]); self.assertTrue(service["read_only"])
                self.assertEqual(service["networks"], ["native"])
            self.assertNotIn(keys["dbAdmin"], json.dumps(compose["services"]["native"]))
            self.assertNotIn(keys["dbAdmin"], json.dumps(compose["services"]["worker"]))
            self.assertEqual(recipe["initServices"], ["initializer"])
            # Native signup writes the workspace custom application's manifest
            # before activation; initializer must share the persistent file store.
            for name in ('initializer', 'native', 'worker'):
                self.assertIn({'type': 'volume', 'source': 'storage', 'target': '/var/lib/ava-storage', 'read_only': False}, compose['services'][name]['volumes'])
            credential_mount = {'type': 'volume', 'source': 'runtime_credentials', 'target': '/var/lib/ava-runtime-credentials', 'read_only': False}
            self.assertIn(credential_mount, compose['services']['initializer']['volumes'])
            for name, service in compose['services'].items():
                if name != 'initializer':
                    self.assertTrue(all(mount.get('source') != 'runtime_credentials' for mount in service.get('volumes', [])))

    def test_render_rejects_wrong_scope_mutable_images_reused_or_invalid_secrets_and_small_reservation(self):
        row, images, keys = self.fixture()
        cases = []
        cases += [{**row, "businessId": 732}, {**row, "hostname": "evil.example"}, {**row, "reservedMemoryMiB": 1}]
        for bad_images in [{**images, "nativeImage": "repo/native:latest"}, {**images, "postgresImage": "postgres:latest"}]:
            cases.append((row, bad_images, keys))
        bad_keys = dict(keys); bad_keys["redis"] = keys["dbAdmin"]
        cases.append((row, images, bad_keys))
        invalid = dict(keys); invalid["appSecret"] = "short"
        cases.append((row, images, invalid))
        for case in cases:
            args = case if isinstance(case, tuple) else (case, images, keys)
            with self.subTest(case=args):
                with self.assertRaises(factory.DeploymentError): factory.render(*args, tempfile.gettempdir())

    def test_rendered_compose_passes_real_validation_with_only_filesystem_check_patched(self):
        row, images, keys = self.fixture()
        with tempfile.TemporaryDirectory() as tmp:
            files, compose, recipe = factory.render(row, images, keys, tmp)
            with mock.patch.object(module_deployment_helper, "owned_path", side_effect=lambda path, owner=0, directory=False: Path(path)):
                factory.validate_compose(compose, recipe, Path(tmp))

    def test_prepare_resume_freezes_initial_display_after_partial_write(self):
        row, images, _ = self.fixture()
        with tempfile.TemporaryDirectory() as tmp:
            recipes, catalogue = Path(tmp) / 'recipes', Path(tmp) / 'catalogue.json'
            recipes.mkdir(); catalogue.write_text('{}')
            subject = factory.TwentyRecipeFactory(recipes, catalogue)
            real_write, calls = subject._write, [0]
            def interrupted(path, content, mode=0o600, gid=0):
                calls[0] += 1
                if calls[0] == 3: raise OSError('simulated interruption')
                return real_write(path, content, mode, gid)
            with mock.patch.object(factory.os, 'geteuid', return_value=0), mock.patch.object(factory.os, 'chown'), \
                 mock.patch.object(factory, 'owned_path', side_effect=lambda path, **kwargs: Path(path)), \
                 mock.patch.object(factory, 'private_json', side_effect=lambda p: (b'{}', images) if Path(p) == catalogue else (b'', json.loads(Path(p).read_text()))), \
                 mock.patch.object(factory, 'validate_compose'), mock.patch.object(subject, '_write', side_effect=interrupted):
                with self.assertRaises(OSError): subject.prepare({**row, 'businessName': 'First name'})
            marker = json.loads((recipes / row['id'] / 'preparation.json').read_text())
            self.assertEqual(marker['displayName'], 'First name')
            with mock.patch.object(factory.os, 'geteuid', return_value=0), mock.patch.object(factory.os, 'chown'), \
                 mock.patch.object(factory, 'owned_path', side_effect=lambda path, **kwargs: Path(path)), \
                 mock.patch.object(factory, 'private_json', side_effect=lambda p: (b'{}', images) if Path(p) == catalogue else (b'', json.loads(Path(p).read_text()))), \
                 mock.patch.object(factory, 'validate_compose'):
                subject.prepare({**row, 'businessName': 'Renamed later'})
            bootstrap = json.loads((recipes / row['id'] / 'config' / 'bootstrap.json').read_text())
            self.assertEqual(bootstrap['displayName'], 'First name')

    def test_gateway_is_owned_scoped_and_has_no_database_or_worker_credentials(self):
        row, images, keys = self.fixture()
        row['reservedMemoryMiB'] = 4352
        images['gateway'] = {'image': 'sha256:' + 'd' * 64, 'brokerOrigin': 'http://ava-module-access:3901'}
        keys.update({'brokerPeer': 'X' * 43, 'gatewayEncryption': 'Y' * 43})
        with tempfile.TemporaryDirectory() as tmp:
            files, compose, recipe = factory.render(row, images, keys, tmp)
            gateway = compose['services']['gateway']
            self.assertEqual(gateway['networks'], ['native', 'ingress', 'access'])
            self.assertNotIn('env_file', gateway)
            self.assertNotIn('ports', gateway)
            mounts = [item['source'] for item in gateway['volumes']]
            for forbidden in ('native.env', 'database.env', 'worker.key', 'session.key'):
                self.assertFalse(any(forbidden in path for path in mounts))
            config = json.loads(files['gateway.json'][0])
            self.assertEqual(config['adapterId'], row['id'])
            self.assertEqual(config['nativeScopeFile'], '/run/ava-bootstrap/bootstrap.json')
            self.assertEqual(config['nativeOrigin'], 'http://native:3902')
            self.assertEqual(config['publicOrigin'], 'https://' + row['hostname'])
            self.assertLessEqual(sum(item['mem_limit'] for item in compose['services'].values()), 4352 * 1024**2)
            for value in keys.values():
                self.assertNotIn(value, json.dumps(compose))
                self.assertNotIn(value, json.dumps(recipe))
            with mock.patch.object(module_deployment_helper, 'owned_path', side_effect=lambda path, **kwargs: Path(path)):
                factory.validate_compose(compose, recipe, Path(tmp))

    def test_gateway_requires_additional_capacity_distinct_keys_and_reviewed_broker(self):
        row, images, keys = self.fixture()
        images['gateway'] = {'image': 'sha256:' + 'd' * 64, 'brokerOrigin': 'http://ava-module-access:3901'}
        keys.update({'brokerPeer': 'X' * 43, 'gatewayEncryption': 'Y' * 43})
        with self.assertRaisesRegex(factory.DeploymentError, 'DEPLOYMENT_RESERVATION_TOO_SMALL'):
            factory.render(row, images, keys, '/approved/root')
        row['reservedMemoryMiB'] = 4352
        for bad in ['https://evil.example', 'http://user:password@ava-module-access:3901', 'http://ava-module-access:3901/custom']:
            with self.assertRaisesRegex(factory.DeploymentError, 'DEPLOYMENT_IMAGE_CATALOGUE_INVALID'):
                factory.render(row, {**images, 'gateway': {**images['gateway'], 'brokerOrigin': bad}}, keys, '/approved/root')


if __name__ == "__main__": unittest.main()
