"""Unit tests for deployment-helper safety contracts; no live Docker evidence."""
import importlib.util
import hashlib
import json
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("module_deployment_helper", ROOT / "scripts/module_deployment_helper.py")
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


class DeploymentHelperUnitTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='ava-helper-unit-')
        self.recipe_root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def _compose_fixture(self):
        recipe = {"deploymentId": str(uuid.uuid4()), "businessId": 7, "revision": 1, "memoryMiB": 256}
        compose = {"services": {"gateway": {"image": "repo/gateway@sha256:" + "a" * 64,
            "read_only": True, "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
            "labels": {helper.LABEL: recipe["deploymentId"], "tech.melud.ava.business": "7", "tech.melud.ava.revision": "1"},
            "mem_limit": 128 * 1024**2, "cpus": 1, "pids_limit": 64, "networks": ["private"]}},
            "networks": {"private": {"internal": True}}, "volumes": {}}
        return recipe, compose

    def test_compose_rejects_host_ports_external_native_image_tag_docker_socket_and_overbudget(self):
        recipe, compose = self._compose_fixture()
        mutations = []
        mutations.append(lambda c: c["services"]["gateway"].update(ports=["127.0.0.1:80:80"]))
        mutations.append(lambda c: c["networks"].update(access={"external": True, "name": "ava-module-access"}) or c["services"].update(worker={**c["services"]["gateway"], "networks": ["access"]}))
        mutations.append(lambda c: c["services"]["gateway"].update(image="repo/gateway:latest"))
        mutations.append(lambda c: c["services"]["gateway"].update(volumes=[{"type": "bind", "source": "/var/run/docker.sock", "target": "/var/run/docker.sock", "read_only": True}]))
        mutations.append(lambda c: c["services"]["gateway"].update(mem_limit=512 * 1024**2))
        for mutate in mutations:
            candidate = json.loads(json.dumps(compose)); mutate(candidate)
            with self.subTest(candidate=candidate):
                with self.assertRaises(helper.DeploymentError):
                    helper.validate_compose(candidate, recipe, Path(tempfile.gettempdir()))

    def test_request_identity_rejects_extra_fields_url_path_bool_and_wrong_uuid(self):
        good = {"deploymentId": str(uuid.uuid4()), "businessId": 7, "revision": 1, "leaseToken": str(uuid.uuid4())}
        for bad in [
            {**good, "extra": 1}, {**good, "deploymentId": "https://evil"},
            {**good, "deploymentId": "/tmp/recipe"}, {**good, "businessId": True},
            {**good, "leaseToken": str(uuid.uuid4()).upper()},
        ]:
            with self.subTest(bad=bad):
                with self.assertRaisesRegex(helper.DeploymentError, "DEPLOYMENT_REQUEST_INVALID"):
                    helper.request_identity(bad)

    def test_lease_rejects_wrong_tenant_expired_disabled_and_revision(self):
        with tempfile.TemporaryDirectory() as tmp:
            dbpath = Path(tmp) / "state.sqlite"
            deployment = str(uuid.uuid4()); token = str(uuid.uuid4())
            with sqlite3.connect(dbpath) as db:
                db.executescript("CREATE TABLE instances (id INTEGER PRIMARY KEY, isActive INTEGER);"
                                 "CREATE TABLE ava_module_deployments (id TEXT,businessId INTEGER,state TEXT,revision INTEGER,leaseToken TEXT,leasedUntil INTEGER);")
                db.execute("INSERT INTO instances VALUES (7,1)")
                db.execute("INSERT INTO ava_module_deployments VALUES (?,?,?,?,?,?)", (deployment, 7, "provisioning", 2, token, 9999999999999))
                db.commit()
            obj = helper.Deployments(dbpath, tmp, clock=lambda: 1)
            base = {"deploymentId": deployment, "businessId": 7, "revision": 2, "leaseToken": token}
            for bad in [{**base, "businessId": 8}, {**base, "revision": 1}, {**base, "leaseToken": str(uuid.uuid4())}]:
                with self.assertRaisesRegex(helper.DeploymentError, "DEPLOYMENT_LEASE_LOST"):
                    obj._lease(bad)
            with sqlite3.connect(dbpath) as db:
                db.execute("UPDATE ava_module_deployments SET leasedUntil=0"); db.commit()
            with self.assertRaisesRegex(helper.DeploymentError, "DEPLOYMENT_LEASE_LOST"):
                obj._lease(base)
            with sqlite3.connect(dbpath) as db:
                db.execute("UPDATE ava_module_deployments SET leasedUntil=?, state='disabled'", (9999999999999,)); db.commit()
            with self.assertRaisesRegex(helper.DeploymentError, "DEPLOYMENT_LEASE_LOST"):
                obj._lease(base)

    def test_reconcile_does_not_run_commands_and_returns_exact_identity(self):
        obj = helper.Deployments("/tmp/unused", "/tmp/unused", runner=mock.Mock())
        row = {"id": str(uuid.uuid4()), "businessId": 7, "module": "onyx", "revision": 3,
               "hostname": "qa.example", "namespace": "ava_demo", "sourceCommit": "abc"}
        obj._lease = mock.Mock(return_value={**row, "state": "provisioning"})
        obj._recipe = mock.Mock(return_value=(self.recipe_root, {}, {"services": {}}))
        obj._state = mock.Mock(return_value="absent")
        result = obj.execute("reconcile", {"deploymentId": row["id"], "businessId": 7, "revision": 3, "leaseToken": str(uuid.uuid4())})
        self.assertEqual(result, {**{key: row["id"] if key == "deploymentId" else row[key] for key in helper.IDENTITY}, "state": "absent"})
        obj.runner.assert_not_called()

    def test_root_catalogues_dispatch_only_to_the_exact_modules_factory(self):
        twenty, onyx = mock.Mock(), mock.Mock()
        dispatch = helper.ApprovedRecipeFactories({'twenty': twenty, 'onyx': onyx})
        row = {'module': 'onyx', 'businessId': 7, 'id': str(uuid.uuid4())}
        dispatch.prepare(row)
        onyx.prepare.assert_called_once_with(row); twenty.prepare.assert_not_called()
        dispatch.prepare({**row, 'module': 'twenty'})
        twenty.prepare.assert_called_once_with({**row, 'module': 'twenty'})
        with self.assertRaisesRegex(helper.DeploymentError, 'DEPLOYMENT_RECIPE_REQUIRED'):
            helper.ApprovedRecipeFactories({'twenty': twenty}).prepare(row)
        with self.assertRaisesRegex(helper.DeploymentError, 'DEPLOYMENT_RECIPE_REQUIRED'):
            dispatch.prepare({**row, 'module': '../../foreign'})
        with self.assertRaisesRegex(helper.DeploymentError, 'DEPLOYMENT_HELPER_CONFIGURATION_INVALID'):
            helper.ApprovedRecipeFactories({'arbitrary': mock.Mock()})

    def test_verify_requires_native_verifier_and_rechecks_lease_after_proof(self):
        obj = helper.Deployments("/tmp/unused", "/tmp/unused", runner=mock.Mock())
        payload = {"deploymentId": str(uuid.uuid4()), "businessId": 7, "revision": 1, "leaseToken": str(uuid.uuid4())}
        row = {"id": payload["deploymentId"], "businessId": 7, "module": "onyx", "revision": 1,
               "hostname": "h", "namespace": "n", "sourceCommit": "s", "state": "provisioning"}
        obj._lease = mock.Mock(return_value=row); obj._recipe = mock.Mock(return_value=(self.recipe_root, {}, {"services": {}}))
        obj._state = mock.Mock(return_value="running")
        with self.assertRaisesRegex(helper.DeploymentError, "DEPLOYMENT_NATIVE_VERIFIER_REQUIRED"):
            obj.execute("verify", payload)
        verifier = mock.Mock(return_value={"health": "ready"}); obj.verifier = verifier
        self.assertEqual(obj.execute("verify", payload), {"health": "ready"})
        self.assertGreaterEqual(obj._lease.call_count, 3)

    def test_enrollment_is_scoped_running_only_and_rechecks_lease_after_native_read(self):
        obj = helper.Deployments('/tmp/unused', '/tmp/unused', runner=mock.Mock())
        row = {'id': str(uuid.uuid4())}
        obj._lease = mock.Mock(return_value=row)
        obj._recipe = mock.Mock(return_value=(self.recipe_root, {}, {}))
        obj._state = mock.Mock(return_value='degraded')
        obj._enrollment = mock.Mock(return_value={'adapterId': row['id']})
        with self.assertRaisesRegex(helper.DeploymentError, 'DEPLOYMENT_NOT_RUNNING'):
            obj.execute('enrollment', {})
        obj._enrollment.assert_not_called()
        obj._state.return_value = 'running'
        self.assertEqual(obj.execute('enrollment', {}), {'adapterId': row['id']})
        def read(*args):
            obj._lease.side_effect = helper.DeploymentError('DEPLOYMENT_LEASE_LOST')
            return {'adapterId': row['id']}
        obj._enrollment.side_effect = read
        with self.assertRaisesRegex(helper.DeploymentError, 'DEPLOYMENT_LEASE_LOST'):
            obj.execute('enrollment', {})

    def test_enrollment_native_scope_must_match_before_reading_any_key(self):
        obj = helper.Deployments('/tmp/unused', '/tmp/unused', runner=mock.Mock())
        row = {'id': str(uuid.uuid4()), 'businessId': 7, 'revision': 3, 'module': 'twenty'}
        obj._containers = mock.Mock(return_value=[{'Id': 'a' * 64, 'Config': {'Labels': {'com.docker.compose.service': 'native'}}}])
        for proof in [{'businessId': 8, 'deploymentId': row['id'], 'revision': 3, 'nativeScope': str(uuid.uuid4())},
                      {'businessId': 7, 'deploymentId': row['id'], 'revision': 2, 'nativeScope': str(uuid.uuid4())},
                      {'businessId': 7, 'deploymentId': row['id'], 'revision': 3, 'nativeScope': 'untrusted'},
                      {'businessId': 7, 'deploymentId': row['id'], 'revision': 3, 'nativeScope': str(uuid.uuid4()), 'password': 'unexpected'}]:
            obj.runner.return_value = json.dumps(proof)
            with self.assertRaisesRegex(helper.DeploymentError, 'DEPLOYMENT_ENROLLMENT_INVALID'):
                obj._enrollment(row, self.recipe_root, {'services': {'gateway': {}}})

    def _onyx_enrollment_fixture(self):
        deployment_id = str(uuid.uuid4())
        row = {'id': deployment_id, 'businessId': 911001, 'revision': 1, 'module': 'onyx',
               'namespace': 'ava_' + deployment_id.replace('-', ''),
               'hostname': 'helper-qa.knowledge.meludtech.tech', 'sourceCommit': helper.PINNED['onyx']}
        manifest = {**helper.Deployments.identity(row), 'schemaVersion': 1,
                    'adapterId': deployment_id, 'nativeScope': row['namespace']}
        return row, manifest, {'services': {'gateway': {}, 'auth': {}, 'api': {}}}

    def test_onyx_enrollment_is_stable_identity_only_without_bootstrap_shell(self):
        row, manifest, compose = self._onyx_enrollment_fixture()
        obj = helper.Deployments('/unused', '/unused', runner=mock.Mock())
        obj._enrollment_peer_hash = mock.Mock(return_value='a' * 64)
        with mock.patch.object(helper, 'private_json', return_value=(b'', manifest)) as read:
            first = obj._enrollment(row, self.recipe_root, compose)
            self.assertEqual(first, obj._enrollment(row, self.recipe_root, compose))
        self.assertEqual(first, {**helper.Deployments.identity(row), 'adapterId': row['id'],
                               'nativeScope': row['namespace'], 'peerSecretHash': 'a' * 64})
        self.assertFalse(any(key in first for key in ('state', 'nativeIdentityVerified', 'tlsVerified')))
        obj.runner.assert_not_called()
        self.assertEqual(read.call_args.args[0], self.recipe_root / 'config' / 'enrollment.json')

    def test_onyx_enrollment_rejects_every_manifest_drift_before_reading_key(self):
        row, good, compose = self._onyx_enrollment_fixture()
        obj = helper.Deployments('/unused', '/unused', runner=mock.Mock())
        obj._enrollment_peer_hash = mock.Mock()
        candidates = [{**good, key: 'foreign'} for key in good]
        candidates += [{**good, 'businessId': True}, {**good, 'revision': True},
                       {**good, 'schemaVersion': True}, {**good, 'secret': 'not-allowed'}]
        candidates += [{key: value for key, value in good.items() if key != missing} for missing in good]
        for manifest in candidates:
            with self.subTest(manifest=manifest), mock.patch.object(helper, 'private_json', return_value=(b'', manifest)):
                with self.assertRaisesRegex(helper.DeploymentError, 'DEPLOYMENT_ENROLLMENT_INVALID'):
                    obj._enrollment(row, self.recipe_root, compose)
        obj._enrollment_peer_hash.assert_not_called()
        obj.runner.assert_not_called()

    def test_onyx_enrollment_requires_auth_api_gateway_and_trusted_manifest(self):
        row, _manifest, compose = self._onyx_enrollment_fixture()
        obj = helper.Deployments('/unused', '/unused', runner=mock.Mock())
        obj._enrollment_peer_hash = mock.Mock()
        for missing in compose['services']:
            incomplete = {'services': {key: value for key, value in compose['services'].items() if key != missing}}
            with self.subTest(missing=missing), mock.patch.object(helper, 'private_json') as read:
                with self.assertRaisesRegex(helper.DeploymentError, 'DEPLOYMENT_GATEWAY_REQUIRED'):
                    obj._enrollment(row, self.recipe_root, incomplete)
                read.assert_not_called()
        with mock.patch.object(helper, 'private_json', side_effect=helper.DeploymentError('DEPLOYMENT_RECIPE_UNTRUSTED')):
            with self.assertRaisesRegex(helper.DeploymentError, 'DEPLOYMENT_RECIPE_UNTRUSTED'):
                obj._enrollment(row, self.recipe_root, compose)
        obj._enrollment_peer_hash.assert_not_called()

    def test_onyx_enrollment_rejects_self_consistent_foreign_namespace_or_source(self):
        row, manifest, compose = self._onyx_enrollment_fixture()
        obj = helper.Deployments('/unused', '/unused', runner=mock.Mock())
        obj._enrollment_peer_hash = mock.Mock()
        for key, value in [('namespace', 'ava_' + 'b' * 32), ('sourceCommit', 'b' * 40)]:
            bad_row, bad_manifest = {**row, key: value}, {**manifest, key: value}
            if key == 'namespace': bad_manifest['nativeScope'] = value
            with self.subTest(key=key), mock.patch.object(helper, 'private_json', return_value=(b'', bad_manifest)):
                with self.assertRaisesRegex(helper.DeploymentError, 'DEPLOYMENT_ENROLLMENT_INVALID'):
                    obj._enrollment(bad_row, self.recipe_root, compose)
        obj._enrollment_peer_hash.assert_not_called()

    def test_verify_fails_if_lease_revision_changes_after_verifier_callback(self):
        with tempfile.TemporaryDirectory() as tmp:
            obj = helper.Deployments(Path(tmp) / "db", tmp, runner=mock.Mock())
            payload = {"deploymentId": str(uuid.uuid4()), "businessId": 7, "revision": 1, "leaseToken": str(uuid.uuid4())}
            row = {"id": payload["deploymentId"], "businessId": 7, "module": "onyx", "revision": 1,
                   "hostname": "h", "namespace": "ava_n", "sourceCommit": "s", "state": "provisioning"}
            obj._recipe = mock.Mock(return_value=(Path(tmp), {}, {"services": {}})); obj._state = mock.Mock(return_value="running")
            current = [1]
            def lease(_):
                if current[0] != 1: raise helper.DeploymentError("DEPLOYMENT_LEASE_LOST")
                return row
            def verifier(*_):
                current[0] = 2
                return {"health": "ready"}
            obj._lease, obj.verifier = lease, verifier
            with self.assertRaisesRegex(helper.DeploymentError, "DEPLOYMENT_LEASE_LOST"):
                obj.execute("verify", payload)

    def test_provision_rechecks_lease_and_stops_owned_project_after_revoke(self):
        obj = helper.Deployments("/tmp/unused", "/tmp/unused", runner=mock.Mock())
        payload = {"deploymentId": str(uuid.uuid4()), "businessId": 7, "revision": 1, "leaseToken": str(uuid.uuid4())}
        row = {"id": payload["deploymentId"], "businessId": 7, "module": "onyx", "revision": 1,
               "hostname": "h", "namespace": "ava_n", "sourceCommit": "s", "state": "provisioning"}
        obj._recipe = mock.Mock(return_value=(self.recipe_root, {"memoryMiB": 256}, {"services": {"gateway": {}}}))
        obj._state = mock.Mock(return_value="absent")
        calls = []
        def lease(_):
            calls.append(1)
            if len(calls) >= 4: raise helper.DeploymentError("DEPLOYMENT_LEASE_LOST")
            return row
        obj._lease = lease
        with self.assertRaisesRegex(helper.DeploymentError, "DEPLOYMENT_LEASE_LOST"):
            obj.execute("provision", payload)
        commands = [call.args[0] for call in obj.runner.call_args_list]
        self.assertTrue(any("stop" in command for command in commands))

    def test_partial_failed_start_also_stops_when_lease_was_revoked(self):
        obj = helper.Deployments('/unused', '/unused')
        row = {'id': str(uuid.uuid4()), 'namespace': 'ava_qa'}
        obj._lease = mock.Mock(return_value=row)
        obj._recipe = mock.Mock(return_value=(self.recipe_root, {}, {'services': {}}))
        obj._state = mock.Mock(return_value='absent')
        commands = []
        def runner(command, **kwargs):
            commands.append(command)
            if 'up' in command:
                obj._lease.side_effect = helper.DeploymentError('DEPLOYMENT_LEASE_LOST')
                raise helper.DeploymentError('DEPLOYMENT_OPERATION_FAILED')
        obj.runner = runner
        with self.assertRaisesRegex(helper.DeploymentError, 'DEPLOYMENT_LEASE_LOST'):
            obj.execute('provision', {})
        self.assertEqual(sum('stop' in command for command in commands), 1)
        self.assertFalse(any('down' in command for command in commands))

    def test_foreign_container_in_partially_owned_project_is_not_adopted(self):
        obj = helper.Deployments('/unused', '/unused', runner=mock.Mock(return_value='a' * 64 + '\n' + 'b' * 64))
        obj._containers = mock.Mock(return_value=[{'Id': 'a' * 64}])
        with self.assertRaisesRegex(helper.DeploymentError, 'DEPLOYMENT_RESOURCE_OWNERSHIP_CONFLICT'):
            obj._state({'id': str(uuid.uuid4()), 'namespace': 'ava_qa'}, {'services': {}})

    def test_provision_existing_running_does_not_issue_compose_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            obj = helper.Deployments(Path(tmp) / "db", tmp, runner=mock.Mock())
            payload = {"deploymentId": str(uuid.uuid4()), "businessId": 7, "revision": 1, "leaseToken": str(uuid.uuid4())}
            row = {"id": payload["deploymentId"], "businessId": 7, "module": "onyx", "revision": 1,
                   "hostname": "h", "namespace": "ava_n", "sourceCommit": "s", "state": "provisioning"}
            obj._lease = mock.Mock(return_value=row); obj._recipe = mock.Mock(return_value=(Path(tmp), {}, {"services": {}}))
            obj._state = mock.Mock(return_value="running")
            result = obj.execute("provision", payload)
            self.assertEqual(result["state"], "running")
            self.assertFalse(any(" up " in " " + " ".join(call.args[0]) + " " for call in obj.runner.call_args_list))

    def test_init_service_state_matrix(self):
        deployment = str(uuid.uuid4()); row = {'id': deployment, 'businessId': 7, 'revision': 1, 'namespace': 'ava_q'}
        compose = {'services': {'gateway': {'image': 'repo/g@sha256:' + 'a'*64}, 'init': {'image': 'repo/i@sha256:' + 'b'*64}}, '_initServices': ['init']}
        def item(name, running, exit_code=0):
            state = {'Running': running, 'ExitCode': exit_code, 'Health': {'Status': 'healthy'}}
            if name == 'init' and not running: state['Status'] = 'exited'
            return {'Id': ('a' if name == 'gateway' else 'b') * 64, 'Config': {'Image': compose['services'][name]['image'], 'Labels': {helper.LABEL: deployment, 'com.docker.compose.service': name, 'com.docker.compose.project': 'ava_q', 'tech.melud.ava.business': '7', 'tech.melud.ava.revision': '1'}}, 'State': state}
        for init_running, exit_code, expected in [(True, 0, 'degraded'), (False, 0, 'running')]:
            obj = helper.Deployments('/unused', '/unused', runner=mock.Mock(return_value=('a'*64+'\n'+'b'*64)))
            obj._containers = mock.Mock(return_value=[item('gateway', True), item('init', init_running, exit_code)])
            self.assertEqual(obj._state(row, compose), expected)
        obj = helper.Deployments('/unused', '/unused', runner=mock.Mock(return_value=('a'*64+'\n'+'b'*64)))
        obj._containers = mock.Mock(return_value=[item('gateway', True), item('init', False, 1)])
        self.assertEqual(obj._state(row, compose), 'degraded')

    def test_init_services_recipe_validation_rejects_invalid_entries(self):
        recipe, compose = self._compose_fixture()
        for value, mutation in [([{}], None), ('gateway', None), ([True], None), (['missing'], None), (['gateway','gateway'], None), (['gateway'], lambda c: c['services']['gateway'].update(restart='always')), (['gateway'], lambda c: c['networks'].update(access={'external': True, 'name': 'ava-module-access'}) or c['services']['gateway'].update(networks=['access']))]:
            candidate = json.loads(json.dumps(compose)); candidate_recipe = {**recipe, 'initServices': value}
            if mutation: mutation(candidate)
            with self.subTest(value=value):
                with self.assertRaises(helper.DeploymentError): helper.validate_compose(candidate, candidate_recipe, Path(tempfile.gettempdir()))

    def test_running_init_cannot_hide_foreign_later_container(self):
        obj = helper.Deployments('/unused', '/unused', runner=mock.Mock(return_value='a'*64+'\n'+'b'*64))
        deployment = str(uuid.uuid4())
        row = {'id': deployment, 'namespace': 'ava_test', 'businessId': 7, 'revision': 1}
        labels = {helper.LABEL: deployment, 'com.docker.compose.project': 'ava_test',
                  'tech.melud.ava.business': '7', 'tech.melud.ava.revision': '1'}
        first = {'Id': 'a'*64, 'Config': {'Image': 'sha256:'+'a'*64, 'Labels': {**labels, 'com.docker.compose.service': 'init'}}, 'State': {'Running': True}}
        second = {'Id': 'b'*64, 'Config': {'Image': 'sha256:'+'a'*64, 'Labels': {**labels, 'tech.melud.ava.business': '8', 'com.docker.compose.service': 'native'}}, 'State': {'Running': True}}
        compose = {'services': {name: {'image': 'sha256:'+'a'*64} for name in ('init','native')}, '_initServices':['init']}
        obj._containers = mock.Mock(return_value=[first, second])
        with self.assertRaisesRegex(helper.DeploymentError, 'OWNERSHIP_CONFLICT'): obj._state(row, compose)

    def test_never_started_initializer_is_not_success(self):
        obj = helper.Deployments('/unused', '/unused', runner=mock.Mock(return_value='a'*64))
        row = {'id': str(uuid.uuid4()), 'namespace': 'ava_test', 'businessId': 7, 'revision': 1}
        obj._containers = mock.Mock(return_value=[{'Id': 'a'*64, 'Config': {'Image': 'sha256:'+'a'*64,
            'Labels': {'com.docker.compose.project': 'ava_test', 'tech.melud.ava.business': '7', 'tech.melud.ava.revision':'1', 'com.docker.compose.service':'init'}},
            'State': {'Running': False, 'Status': 'created', 'ExitCode': 0}}])
        self.assertEqual(obj._state(row, {'services': {'init': {'image':'sha256:'+'a'*64}}, '_initServices':['init']}), 'degraded')

    def test_optional_init_field_cannot_hide_missing_required_recipe_field(self):
        obj = helper.Deployments('/unused', self.recipe_root)
        row = {'id': str(uuid.uuid4()), 'businessId':7, 'module':'twenty', 'revision':1,
               'hostname':'h', 'namespace':'n', 'sourceCommit':helper.PINNED['twenty']}
        recipe = {**helper.Deployments.identity(row), 'schemaVersion':1, 'initServices':[], 'memoryMiB':256, 'imageDigest':'sha256:'+'a'*64}
        with mock.patch.object(helper, 'private_json', side_effect=[(b'{}',recipe),(b'{}',{})]):
            with self.assertRaisesRegex(helper.DeploymentError,'DEPLOYMENT_RECIPE_INVALID'): obj._recipe(row)

    def test_factory_prepares_missing_recipe_and_lease_revocation_stops_docker(self):
        payload = {'deploymentId': str(uuid.uuid4()), 'businessId': 7, 'revision': 1, 'leaseToken': str(uuid.uuid4())}
        row = {'id': payload['deploymentId'], 'businessId': 7, 'module': 'onyx', 'revision': 1, 'hostname': 'h', 'namespace': 'ava_n', 'sourceCommit': helper.PINNED['onyx'], 'reservedMemoryMiB': 256, 'state': 'provisioning'}
        factory = mock.Mock(); obj = helper.Deployments('/unused', self.recipe_root, runner=mock.Mock(), recipe_factory=factory)
        # Simulate a factory which creates the two checked-in recipe files.
        def prepare(_):
            root = self.recipe_root / row['id']; root.mkdir(); recipe = {**helper.Deployments.identity(row), 'schemaVersion': 1, 'composeSha256': '', 'imageDigest': 'sha256:'+'a'*64, 'memoryMiB': 256}; compose = {'services': {}}
            raw = json.dumps(compose).encode(); recipe['composeSha256'] = hashlib.sha256(raw).hexdigest(); (root/'recipe.json').write_text(json.dumps(recipe)); (root/'compose.json').write_bytes(raw)
        factory.prepare.side_effect = prepare
        obj._lease = mock.Mock(return_value=row); obj._state = mock.Mock(return_value='absent')
        recipe = {**helper.Deployments.identity(row), 'schemaVersion':1, 'composeSha256':'x', 'imageDigest':'sha256:'+'a'*64, 'memoryMiB':256}; compose={'services':{}}
        with mock.patch.object(helper, 'private_json', side_effect=[FileNotFoundError(), (b'{}', recipe), (b'{}', compose)]):
            with self.assertRaises(helper.DeploymentError): obj.execute('provision', payload)
        self.assertEqual(factory.prepare.call_count, 1)
        # A revoked lease after factory preparation must preclude Docker calls.
        obj2 = helper.Deployments('/unused', self.recipe_root, runner=mock.Mock(), recipe_factory=mock.Mock())
        obj2._recipe = mock.Mock(return_value=(self.recipe_root, {'memoryMiB':256}, {'services': {}})); obj2._lease = mock.Mock(side_effect=[row, helper.DeploymentError('DEPLOYMENT_LEASE_LOST')])
        with self.assertRaisesRegex(helper.DeploymentError, 'DEPLOYMENT_LEASE_LOST'): obj2.execute('provision', payload)
        obj2.runner.assert_not_called()


if __name__ == "__main__":
    unittest.main()
