"""Isolated release tests. No test calls Docker, SSH, or a production URL."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import pathlib
import sqlite3
import tempfile
import types
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('registration_operator', pathlib.Path(__file__).with_name('release_operator.py'))
op = importlib.util.module_from_spec(spec)
spec.loader.exec_module(op)


def hashed(value):
    return hashlib.sha256(value.encode()).hexdigest()


class DockerFixture:
    """Models Docker commands; uses a real, deliberately uncheckpointed SQLite DB."""
    ddl = ('CREATE TABLE IF NOT EXISTS release_accounts(id INTEGER PRIMARY KEY, email TEXT); '
           'CREATE INDEX IF NOT EXISTS release_accounts_email ON release_accounts(email); '
           'CREATE TABLE IF NOT EXISTS ava_self_registrations(id INTEGER PRIMARY KEY, state TEXT);')

    def __init__(self, root):
        self.root = root
        self.commands, self.ups, self.images, self.tags, self.rows = [], [], {}, {}, {}
        self.fail_up_once = None
        self.remove_before_fail = False
        self.stops = []
        self.on_stop = None
        self.logs = {}
        self.probes = []
        self.access_probes = []
        self.data = root / 'data'
        self.data.mkdir()
        (root / 'data-alias').symlink_to(self.data, target_is_directory=True)
        self.db = self.data / 'crm_v2.db'
        self.connection = sqlite3.connect(self.db)
        self.connection.executescript('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; '
            'CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO messages VALUES(1,\'from WAL\'); '
            'CREATE TABLE ava_invitations(id INTEGER PRIMARY KEY, createdBy TEXT, userId INTEGER, leaseToken TEXT); '
            'CREATE TABLE ava_identity_outbox(id INTEGER PRIMARY KEY, userId INTEGER, state TEXT);')
        self.connection.commit()
        self.bundle = root / 'bundle'
        self.bundle.mkdir()
        self.manifest = {'schemaVersion': 2, 'baseCommit': 'a' * 40, 'candidateCommit': 'b' * 40,
            'publicBaseUrl': 'https://wh.meludtech.tech', 'publicRoutes': ['/login', '/register', '/forgot-password'], 'services': {}}
        for field in ('migrationRunner', 'contractRunner'):
            runner = self.bundle / (field + '.cjs')
            runner.write_text('// reviewed ' + field)
            self.manifest[field] = {'path': runner.name, 'sha256': op.sha(runner)}
        for i, service in enumerate(op.SERVICES, 1):
            base = 'sha256:' + str(i) * 64
            existing = 'server.js' if service == op.CRM else 'provisioning-worker.js'
            old = {existing: hashed('old ' + service), 'prod-only.js': hashed('preserve production bytes')}
            files = {existing: hashed('candidate ' + service), 'src/registration/new.js': hashed('new contract')}
            if service == op.CRM:
                old['frontend/dist/index.html'] = hashed('old frontend')
                files['frontend/dist/index.html'] = hashed('candidate frontend')
            for name in files:
                p = self.bundle / 'payload' / service / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text('candidate frontend' if name.startswith('frontend/') else
                             'candidate ' + service if name == existing else 'new contract')
            self.manifest['services'][service] = {'baseImageId': base,
                'baseCommit': 'a' * 40,
                'candidateTag': 'ava-registration-' + ('crm' if service == op.CRM else 'worker') + ':fixture',
                'files': files, 'baseFiles': {name: old.get(name) for name in files},
                'baseFileCommits': {name: 'a' * 40 for name in files if not name.startswith('frontend/dist/')},
                'environment': {'AVA_SELF_REGISTRATION_ENABLED': 'true'}}
            config = {'Entrypoint': ['docker-entrypoint.sh'], 'Cmd': ['node', existing]}
            self.images[base] = {'Id': base, 'Config': config, 'hashes': old,
                                 'RootFS': {'Layers': ['base-layer-' + service]}}
            compose_files = [root / f'{service}-compose-{j}.json' for j in range(i + 1)]
            env_files = [root / f'{service}-env-{j}' for j in range(2)]
            for p in compose_files + env_files:
                p.write_text('{}')
            labels = {'com.docker.compose.project': 'ava', 'com.docker.compose.service': service,
                'com.docker.compose.project.config_files': ','.join(map(str, compose_files)),
                'com.docker.compose.project.environment_file': ','.join(map(str, env_files)),
                'com.docker.compose.project.working_dir': str(root)}
            env = {'DB_PATH': '/app/data/crm_v2.db', 'ADMIN_PASSWORD_HASH': '$2b$fixture-secret',
                'RUNTIME_ONLY_SECRET': 'fixture-secret-value', 'SESSION_SECRET': 'synthetic-session-secret-' + 's' * 32,
                'AVA_CUSTOMER_ACCESS_ENABLED': 'true', 'WHATSAPP_CRM_PUBLIC_URL': 'https://wh.meludtech.tech',
                'AVA_OIDC_CLIENT_ID': 'ava-web', 'AVA_OIDC_ISSUER': 'https://auth.meludtech.tech/realms/ava',
                'AVA_IDENTITY_BROKER_TOKEN': 'synthetic-broker-token-' + 'b' * 32,
                'AVA_IDENTITY_ADMIN_CLIENT_ID': 'synthetic-admin-client',
                'AVA_IDENTITY_ADMIN_CLIENT_SECRET': 'synthetic-admin-secret', 'AVA_PROCESS_ROLE':
                'crm' if service == op.CRM else 'provisioning-worker'}
            self.rows[service] = {'Id': 'live-' + service, 'Name': '/' + service, 'Image': base,
                'Config': {**copy.deepcopy(config), 'Env': [k + '=' + v for k, v in env.items()], 'Labels': labels},
                'Mounts': [{'Type': 'bind', 'Source': str(self.data if i == 1 else root / 'data-alias'),
                    'Destination': '/app/data', 'RW': True}], 'HostConfig': {'RestartPolicy': {'Name': 'always'}},
                'State': {'Running': True, 'Paused': False, 'Restarting': False, 'StartedAt': 'old-start'}, 'RestartCount': 0}
            if service == op.CRM:
                self.rows[service]['State']['Health'] = {'Status': 'healthy'}
        self.original_rows = copy.deepcopy(self.rows)
        before = op.schema_and_rows(self.db)
        schema = root / 'schema.db'
        with contextlib.closing(sqlite3.connect(schema)) as db:
            self.connection.backup(db)
            db.executescript(self.ddl)
        after = op.schema_and_rows(schema)
        self.manifest['allowedNewSchema'] = [obj for name, obj in after['objects'].items() if name not in before['objects']]
        (self.bundle / 'manifest.json').write_text(json.dumps(self.manifest))
        self.other = [{'Id': 'voice-native-keycloak', 'Name': '/voice-native-keycloak', 'Image': 'untouched',
            'State': {'Running': True, 'StartedAt': 'old-start'}, 'RestartCount': 0}]
        args = types.SimpleNamespace(bundle=self.bundle, release_dir=root / 'release', candidate_commit='b' * 40,
            manifest_sha256=op.sha(self.bundle / 'manifest.json'))
        self.operator = op.Operator(args)
        self.operator.run = self.run
        self.operator.keycloak_check = mock.Mock(return_value={
            'mode': 'trusted_redirect', 'clientStateVerified': True, 'smtp': {'mailSent': False}})
        self.operator.public = mock.Mock(return_value={'https': True, 'routes': self.manifest['publicRoutes']})

    def close(self):
        self.connection.close()

    def image(self, image):
        resolved = self.tags.get(image, image)
        op.require(resolved in self.images, 'SYNTHETIC_IMAGE_MISSING')
        return self.images[resolved]

    def compose_config(self, args):
        files = [pathlib.Path(args[i + 1]) for i, arg in enumerate(args) if arg == '-f']
        services = {}
        for service, row in self.original_rows.items():
            services[service] = {'image': 'stale-tag', 'environment': {'ADMIN_PASSWORD_HASH': 'stale-on-disk'},
                'command': row['Config']['Cmd'], 'networks': {'default': None},
                'volumes': [{'type': 'bind', 'source': row['Mounts'][0]['Source'], 'target': '/app/data'}]}
        for path in files:
            for service, value in json.loads(path.read_text()).get('services', {}).items():
                services[service].update(value)
        return services

    def run(self, args, cwd=None, input=None, timeout=180):
        self.commands.append(copy.deepcopy(args))
        assert args[0] == 'docker', args
        if args[1] == 'ps':
            if '--filter' in args:
                row = self.rows.get(args[-1].split('=', 2)[-1])
                return row['Id'] if row else ''
            return ' '.join([r['Id'] for r in self.rows.values()] + [r['Id'] for r in self.other])
        if args[1] == 'inspect':
            all_rows = list(self.rows.values()) + self.other
            return json.dumps([r for name in args[2:] for r in all_rows if r['Id'] == name])
        if args[1] == 'logs':
            service = next(name for name, row in self.rows.items() if row['Id'] == args[-1])
            return self.logs.get(service, 'SYNTHETIC_SAFE_LOG')
        if args[1:3] == ['image', 'inspect']:
            item = self.image(args[-1])
            return json.dumps([{k: v for k, v in item.items() if k != 'hashes'}])
        if args[1] == 'tag':
            self.tags[args[3]] = args[2]
            return ''
        if args[1] == 'stop':
            assert args[2:4] == ['-t', '35'], args
            service, row = next((name, row) for name, row in self.rows.items() if row['Id'] == args[-1])
            self.stops.append(service)
            row['State']['Running'] = False
            if self.on_stop:
                self.on_stop(service)
            return ''
        if args[1] == 'build':
            context = pathlib.Path(args[-1])
            base = self.image((context / 'Dockerfile').read_text().splitlines()[0].split()[1])
            item = copy.deepcopy(base)
            item['Id'] = 'sha256:' + hashed(args[args.index('-t') + 1])
            item['RootFS']['Layers'].append('overlay-layer-' + item['Id'])
            for path in (context / 'payload').rglob('*'):
                if path.is_file():
                    item['hashes'][str(path.relative_to(context / 'payload'))] = op.sha(path)
            self.images[item['Id']] = item
            self.tags[args[args.index('-t') + 1]] = item['Id']
            return ''
        if args[1] == 'compose':
            config = self.compose_config(args)
            if 'config' in args:
                return json.dumps({'services': config})
            assert 'up' in args, args
            service = args[-1]
            self.ups.append((service, config[service]['image'], copy.deepcopy(args)))
            if self.fail_up_once == service:
                self.fail_up_once = None
                if self.remove_before_fail:
                    self.rows.pop(service)
                raise RuntimeError('SYNTHETIC_COMPOSE_FAILURE')
            row = self.rows.setdefault(service, copy.deepcopy(self.original_rows[service]))
            row['Image'] = config[service]['image']
            row['Config']['Env'] = [k + '=' + v.replace('$$', '$') for k, v in config[service]['environment'].items()]
            row['Id'] = 'recreated-' + service + '-' + str(len(self.ups))
            row['State']['Running'] = True
            row['State']['Restarting'] = False
            row['RestartCount'] = 0
            return ''
        if args[1] == 'exec':
            row = next(r for r in self.rows.values() if r['Id'] == args[2])
            if args[-1] == op.HASH_JS:
                return json.dumps(self.image(row['Image'])['hashes'])
            assert args[-1] in (op.READINESS_JS, getattr(op, 'CANDIDATE_READINESS_JS', None)), args
            service = next(name for name, value in self.rows.items() if value['Id'] == row['Id'])
            self.probes.append((service, row['Image'], args[-1]))
            return json.dumps({'ready': True})
        assert args[1] == 'run' and '--network' in args and args[args.index('--network') + 1] == 'none', args
        image = next((arg for arg in args if arg in self.images or arg in self.tags), None)
        op.require(image is not None, 'SYNTHETIC_IMAGE_MISSING')
        if args[-1] == op.HASH_JS:
            return json.dumps(self.image(image)['hashes'])
        if 'overlayReadable' in args[-1]:
            assert '--user' in args and '--read-only' in args and '--entrypoint' in args, args
            self.access_probes.append(copy.deepcopy(args))
            return json.dumps({'overlayReadable': True})
        mounts = [args[i + 1] for i, arg in enumerate(args) if arg == '--mount']
        data_mount = next(m for m in mounts if 'target=/check' in m)
        directory = pathlib.Path(data_mount.split('source=', 1)[1].split(',')[0])
        db_env = next(arg for arg in args if arg.startswith('DB_PATH='))
        db = directory / pathlib.Path(db_env.split('=', 1)[1]).name
        if args[-1] == op.SNAPSHOT_JS:
            return json.dumps(op.schema_and_rows(db))
        if args[-1] == op.COMPAT_JS:
            op.schema_and_rows(db)
            return json.dumps({'compatibilityOk': True})
        if args[-1] == getattr(op, 'ROLLBACK_ELIGIBILITY_JS', None):
            assert '--read-only' in args and 'target=/check,readonly' in data_mount, args
            return json.dumps(self.rollback_gate(db))
        if args[-1] == 'migrate':
            with contextlib.closing(sqlite3.connect(db)) as connection:
                connection.executescript(self.ddl)
            return json.dumps({'schemaVerified': True})
        assert args[-1] == 'smoke', args
        return json.dumps({'contractVerified': True,
                          'noRedirectRecoveryContractVerified': 'AVA_RELEASE_RECOVERY_NO_REDIRECT=1' in args})

    @staticmethod
    def rollback_gate(path):
        try:
            with contextlib.closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
                for table, columns in (('ava_invitations', {'createdBy', 'userId', 'leaseToken'}),
                                       ('ava_identity_outbox', {'userId', 'state'})):
                    kind = db.execute('SELECT type FROM sqlite_master WHERE name=?', (table,)).fetchone()
                    op.require(kind == ('table',) and columns <= {row[1] for row in db.execute('PRAGMA table_info("' + table + '")')}, 'SYNTHETIC_ROLLBACK_SCHEMA_INVALID')
                invitation_lease = bool(db.execute("SELECT 1 FROM ava_invitations WHERE createdBy LIKE 'self-registration:%' AND leaseToken IS NOT NULL LIMIT 1").fetchone())
                pending_revocation = bool(db.execute("SELECT 1 FROM ava_identity_outbox o WHERE (o.state IS NULL OR o.state != 'done') AND EXISTS (SELECT 1 FROM ava_invitations i WHERE i.userId=o.userId AND i.createdBy LIKE 'self-registration:%') LIMIT 1").fetchone())
                registrations = db.execute("SELECT type FROM sqlite_master WHERE name='ava_self_registrations'").fetchone()
                if registrations:
                    op.require(registrations == ('table',) and 'state' in {row[1] for row in db.execute('PRAGMA table_info(ava_self_registrations)')}, 'SYNTHETIC_ROLLBACK_SCHEMA_INVALID')
                    enrolling_registration = bool(db.execute("SELECT 1 FROM ava_self_registrations WHERE state='enrolling' LIMIT 1").fetchone())
                else:
                    op.require(not db.execute("SELECT 1 FROM ava_invitations WHERE createdBy LIKE 'self-registration:%' LIMIT 1").fetchone(), 'SYNTHETIC_ROLLBACK_SCHEMA_INVALID')
                    enrolling_registration = False
                barriers = {'invitationLease': invitation_lease, 'pendingRevocation': pending_revocation,
                            'enrollingRegistration': enrolling_registration}
                return {'schemaValid': True, 'rollbackEligible': not any(barriers.values()), 'barriers': barriers}
        except (RuntimeError, sqlite3.Error):
            return {'schemaValid': False, 'rollbackEligible': False}


class ReleaseTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        fixture = DockerFixture(pathlib.Path(temporary.name))
        self.addCleanup(fixture.close)
        return fixture

    def quiet(self):
        return contextlib.redirect_stdout(io.StringIO())

    def test_private_umask_keeps_state_private_but_payload_ancestors_searchable_at_build(self):
        f = self.fixture()
        original_run = f.operator.run
        observed = []

        def run(command, **kwargs):
            if command[:2] == ['docker', 'build']:
                context = pathlib.Path(command[-1])
                self.assertEqual(context.stat().st_mode & 0o777, 0o700)
                payload = context / 'payload'
                paths = [payload, *payload.rglob('*')]
                self.assertTrue(any(p.is_dir() and p.name == 'registration' for p in paths))
                for path in paths:
                    self.assertEqual(path.stat().st_mode & 0o777, 0o755 if path.is_dir() else 0o644, str(path))
                self.assertEqual((context / 'Dockerfile').stat().st_mode & 0o777, 0o600)
                lines = (context / 'Dockerfile').read_text().splitlines()
                self.assertTrue(lines[1].startswith('COPY '))
                executable = json.loads(lines[2][4:])
                self.assertEqual(executable[:2], ['node', '-e'])
                self.assertEqual(executable[2], op.overlay_permissions(
                    f.manifest['services'][next(s for s in op.SERVICES if context.name == 'build-'+s)]['files'])[0])
                observed.append(context)
            return original_run(command, **kwargs)

        previous_umask = op.os.umask(0o077)
        try:
            with self.quiet(), mock.patch.object(f.operator, 'run', side_effect=run):
                f.operator.prepare()
        finally:
            op.os.umask(previous_umask)
        self.assertEqual(len(observed), 2)
        self.assertEqual(f.operator.root.stat().st_mode & 0o777, 0o700)
        for path in f.operator.root.glob('*.private.*'):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600, str(path))

    def test_prepare_checks_image_access_as_the_saved_runtime_user_for_both_services(self):
        f = self.fixture()
        for service in op.SERVICES:
            f.rows[service]['Config']['User'] = '1000:986'
        with self.quiet():
            f.operator.prepare()
        self.assertEqual(len(f.access_probes), 2)
        for command in f.access_probes:
            self.assertEqual(command[command.index('--user')+1], '1000:986')
            self.assertEqual(command[command.index('--network')+1], 'none')
            self.assertNotIn('--mount', command)
            self.assertIn('--read-only', command)

    def test_image_access_failure_blocks_prepare_before_backup_or_prepared_state(self):
        f = self.fixture()
        original_run = f.operator.run

        def deny(command, **kwargs):
            if command[:2] == ['docker', 'run'] and 'overlayReadable' in command[-1]:
                return '{"overlayReadable":false}'
            return original_run(command, **kwargs)

        with self.quiet(), mock.patch.object(f.operator, 'run', side_effect=deny):
            with self.assertRaisesRegex(RuntimeError, '^CANDIDATE_RUNTIME_ACCESS_DENIED$'):
                f.operator.prepare()
        self.assertFalse((f.operator.root / 'prepared.private.json').exists())
        self.assertFalse(list(f.operator.root.glob('prepare-backup-*')))
        self.assertEqual(f.ups, [])

    def test_exact_image_chmod_and_access_javascript_handles_restrictive_modes_and_denied_user(self):
        chmod, probe = op.overlay_permissions(['src/registration/new.js', 'frontend/dist/quoted"name.js'])
        harness = r'''
const vm=require('vm'),assert=require('assert');let input='';
process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
const {chmod,probe}=JSON.parse(input),modes=new Map(),changed=[];
const fs={constants:{R_OK:4,X_OK:1},lstatSync:path=>({isDirectory:()=>true,isSymbolicLink:()=>false,mode:modes.get(path)||0o700}),
chmodSync:(path,mode)=>{modes.set(path,mode);changed.push(path)},accessSync:()=>{}};
function check(script){const process={exitCode:0};let output='';vm.runInNewContext(script,{require:()=>fs,process,console:{log:value=>output+=value}});return {code:process.exitCode,output};}
assert.strictEqual(check(probe).code,1);
vm.runInNewContext(chmod,{require:()=>fs});
assert.deepStrictEqual(changed,['/app','/app/frontend','/app/frontend/dist','/app/src','/app/src/registration']);
assert.strictEqual(check(probe).output,'{"overlayReadable":true}');
fs.accessSync=()=>{throw Object.assign(Error('private'),{code:'EACCES'})};
assert.deepStrictEqual(check(probe),{code:1,output:''});
process.stdout.write('PASS');});
'''
        result = op.subprocess.run(['node', '-e', harness], input=json.dumps({'chmod': chmod, 'probe': probe}),
                                   text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'PASS')

    def test_compose_config_and_cutover_interpolate_only_the_reviewed_candidate_sha(self):
        f = self.fixture()
        response = types.SimpleNamespace(returncode=0, stdout='{}')
        commands = [
            ['docker', 'compose', '-p', 'ava', 'config', '--format', 'json'],
            ['docker', 'compose', '-p', 'ava', 'up', '-d', '--no-deps', '--pull', 'never',
             '--force-recreate', 'provisioning_worker'],
        ]
        with mock.patch.dict(op.os.environ, {'AVA_RELEASE_SHA': 'unreviewed-host-value'}):
            for command in commands:
                with self.subTest(action=command[5]), mock.patch.object(
                        op.subprocess, 'run', return_value=response) as run:
                    op.Operator.run(f.operator, command)
                    self.assertEqual(run.call_args.kwargs['env']['AVA_RELEASE_SHA'], 'b' * 40)
                    self.assertEqual(run.call_args.args[0], command)
                    self.assertNotIn('AVA_RELEASE_SHA', op.envmap(f.rows['provisioning_worker']))
            self.assertEqual(op.os.environ['AVA_RELEASE_SHA'], 'unreviewed-host-value')

    def test_non_compose_commands_do_not_get_a_release_interpolation_environment(self):
        f = self.fixture()
        response = types.SimpleNamespace(returncode=0, stdout='{}')
        with mock.patch.object(op.subprocess, 'run', return_value=response) as run:
            op.Operator.run(f.operator, ['docker', 'inspect', 'fixture-container'])
        self.assertIsNone(run.call_args.kwargs['env'])

    def applied_fixture(self):
        f = self.fixture()
        with self.quiet(), mock.patch.object(op.time, 'sleep'):
            f.operator.prepare()
            f.operator.apply()
        f.commands.clear()
        f.ups.clear()
        f.stops.clear()
        return f

    def test_paths_reject_traversal_and_aliases(self):
        for value in ('../server.js', '/etc/passwd', 'a/../b', 'a//b', './a', 'a\\b', 'a\nb', ''):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                op.relative(value)

    def test_payload_rejects_symlink_parent(self):
        f = self.fixture()
        (f.bundle / 'link').symlink_to(f.data, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'SYMLINK_PAYLOAD'):
            op.contained(f.bundle, 'link/crm_v2.db')

    def test_manifest_only_accepts_reviewed_operator_cli_paths(self):
        fixture = self.fixture()
        for name in ('scripts/team-enrollment-lease-recovery.js', 'scripts/team-email-reconciliation.js'):
            for service in op.SERVICES:
                config = fixture.manifest['services'][service]
                config['files'][name] = hashed('operator CLI')
                config['baseFiles'][name] = None
                config['baseFileCommits'][name] = 'a' * 40
            op.validate_manifest(fixture.manifest, 'b' * 40)
        for service in op.SERVICES:
            config = fixture.manifest['services'][service]
            config['files']['scripts/arbitrary.js'] = hashed('unknown CLI')
            config['baseFiles']['scripts/arbitrary.js'] = None
            config['baseFileCommits']['scripts/arbitrary.js'] = 'a' * 40
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_PATH_FORBIDDEN'):
            op.validate_manifest(fixture.manifest, 'b' * 40)

    def test_manifest_requires_two_pinned_images_and_exact_reviewed_commit(self):
        f = self.fixture()
        for edit, error in ((lambda m: m['services'].pop('provisioning_worker'), 'TWO_SERVICE_CONTRACT_REQUIRED'),
                (lambda m: m['services'][op.CRM].update(baseImageId='latest'), 'BASE_IMAGE_UNPINNED'),
                (lambda m: m.update(candidateCommit='c' * 40), 'CANDIDATE_COMMIT_MISMATCH'),
                (lambda m: m['services'][op.CRM]['environment'].update(AVA_PASSWORD_RECOVERY_NO_REDIRECT='true'), 'RECOVERY_MODE_WORKER_ONLY'),
                (lambda m: m['services'][op.CRM]['environment'].update(SECRET='bad'), 'NEW_ENV_FORBIDDEN')):
            value = copy.deepcopy(f.manifest)
            edit(value)
            with self.subTest(error=error), self.assertRaisesRegex(RuntimeError, error):
                op.validate_manifest(value, 'b' * 40)

    def test_staff_enrollment_flag_is_allowed_only_as_an_explicit_boolean_string(self):
        f = self.fixture()
        for enabled in ('true', 'false'):
            value = copy.deepcopy(f.manifest)
            for service in op.SERVICES:
                value['services'][service]['environment']['AVA_TEAM_NEW_ACCOUNT_ENABLED'] = enabled
            self.assertIs(op.validate_manifest(value, 'b' * 40), value)
        for invalid in ('TRUE', '1', 'yes', True, None):
            value = copy.deepcopy(f.manifest)
            value['services'][op.CRM]['environment']['AVA_TEAM_NEW_ACCOUNT_ENABLED'] = invalid
            with self.subTest(invalid=invalid), self.assertRaisesRegex(RuntimeError, 'NEW_ENV_FORBIDDEN'):
                op.validate_manifest(value, 'b' * 40)

    def test_source_fence_preserves_prod_only_and_rejects_changed_or_existing_new_file(self):
        contract = {'baseFiles': {'server.js': hashed('reviewed'), 'src/new.js': None}}
        op.assert_baseline_source({'server.js': hashed('reviewed'), 'prod-only.js': hashed('live')}, contract)
        for files in ({'server.js': hashed('hotfix')}, {'server.js': hashed('reviewed'), 'src/new.js': hashed('live')}):
            with self.assertRaisesRegex(RuntimeError, 'OVERLAY_BASE_SOURCE_DRIFT'):
                op.assert_baseline_source(files, contract)

    def test_manifest_requires_exact_source_commit_provenance_for_every_overlay_file(self):
        f = self.fixture()
        edits = (
            lambda m: m['services'][op.CRM].pop('baseFileCommits'),
            lambda m: m['services']['provisioning_worker']['baseFileCommits'].pop('src/registration/new.js'),
            lambda m: m['services'][op.CRM]['baseFileCommits'].update({'server.js': 'main'}),
            lambda m: m['services'][op.CRM]['baseFileCommits'].update({'server.js': 'a' * 39}),
            lambda m: m['services'][op.CRM]['baseFileCommits'].update({'frontend/dist/index.html': 'a' * 40}),
            lambda m: m['services']['provisioning_worker']['baseFileCommits'].update({'src/unreviewed.js': 'a' * 40}),
        )
        for i, edit in enumerate(edits):
            manifest = copy.deepcopy(f.manifest)
            edit(manifest)
            with self.subTest(edit=i), self.assertRaisesRegex(RuntimeError, 'FILE_BASE_COMMIT_UNPINNED'):
                op.validate_manifest(manifest, 'b' * 40)
        manifest = copy.deepcopy(f.manifest)
        manifest['services'][op.CRM]['baseCommit'] = 'c' * 40
        with self.assertRaisesRegex(RuntimeError, 'CRM_BASE_COMMIT_MISMATCH'):
            op.validate_manifest(manifest, 'b' * 40)

    def test_manifest_contract_support_and_absent_provenance_are_explicit(self):
        f = self.fixture()
        path = 'tests/recovery-no-redirect.test.js'
        manifest = copy.deepcopy(f.manifest)
        manifest['contractSupportFiles'] = [path]
        for service in op.SERVICES:
            row = manifest['services'][service]
            row['files'][path] = hashed('reviewed contract support')
            row['baseFiles'][path] = None
            row['baseFileCommits'][path] = row['baseCommit']
            row['absentContractSupportFiles'] = [path]
        op.validate_manifest(manifest, 'b' * 40)
        cases = (
            (lambda m: m.update(contractSupportFiles=path), 'CONTRACT_SUPPORT_INVALID'),
            (lambda m: m.update(contractSupportFiles=[path, path]), 'CONTRACT_SUPPORT_INVALID'),
            (lambda m: m.update(contractSupportFiles=[17]), 'CONTRACT_SUPPORT_INVALID'),
            (lambda m: m.update(contractSupportFiles=['src/registration/new.js']), 'CONTRACT_SUPPORT_INVALID'),
            (lambda m: m['services'][op.CRM].update(absentContractSupportFiles=path), 'ABSENT_CONTRACT_SUPPORT_INVALID'),
            (lambda m: m['services'][op.CRM].update(absentContractSupportFiles=[path, path]), 'ABSENT_CONTRACT_SUPPORT_INVALID'),
            (lambda m: m['services'][op.CRM].update(absentContractSupportFiles=['src/registration/new.js']), 'ABSENT_CONTRACT_SUPPORT_INVALID'),
            (lambda m: m['services'][op.CRM]['baseFiles'].update({path: hashed('already on image')}), 'ABSENT_CONTRACT_SUPPORT_INVALID'),
            (lambda m: m['services'][op.CRM]['baseFileCommits'].update({path: 'c' * 40}), 'ABSENT_CONTRACT_SUPPORT_INVALID'),
        )
        for i, (edit, error) in enumerate(cases):
            value = copy.deepcopy(manifest)
            edit(value)
            with self.subTest(edit=i), self.assertRaisesRegex(RuntimeError, error):
                op.validate_manifest(value, 'b' * 40)
        missing = copy.deepcopy(manifest)
        worker = missing['services']['provisioning_worker']
        for field in ('files', 'baseFiles', 'baseFileCommits'):
            worker[field].pop(path)
        worker['absentContractSupportFiles'] = []
        with self.assertRaisesRegex(RuntimeError, 'CONTRACT_SUPPORT_MISSING'):
            op.validate_manifest(missing, 'b' * 40)
        undeclared = copy.deepcopy(manifest)
        undeclared['contractSupportFiles'] = []
        for row in undeclared['services'].values():
            row['absentContractSupportFiles'] = []
        undeclared['services'][op.CRM]['baseFileCommits'][path] = 'c' * 40
        with self.assertRaisesRegex(RuntimeError, 'TEST_PROVENANCE_NOT_EXPLICIT'):
            op.validate_manifest(undeclared, 'b' * 40)

    def test_differing_compose_and_env_chains_preserve_order_and_literal_dollars(self):
        f = self.fixture()
        p = f.operator.capture()
        self.assertNotEqual(p['composeInputs'][op.SERVICES[0]], p['composeInputs'][op.SERVICES[1]])
        overrides = f.operator.checked_override(p, p['baseImages'])
        for service in op.SERVICES:
            value = json.loads(overrides[service].read_text())
            self.assertEqual(set(value['services']), {service})
            env = value['services'][service]['environment']
            self.assertEqual(env['ADMIN_PASSWORD_HASH'], '$$2b$$fixture-secret')
            self.assertEqual(env['RUNTIME_ONLY_SECRET'], 'fixture-secret-value')
            cmd, _, _ = op.compose(p['before'][service], overrides[service])
            labels = p['before'][service]['Config']['Labels']
            original_env = labels['com.docker.compose.project.environment_file'].split(',')
            original_files = labels['com.docker.compose.project.config_files'].split(',')
            self.assertEqual(cmd, ['docker', 'compose', '-p', 'ava'] +
                [arg for path in original_env for arg in ('--env-file', path)] +
                [arg for path in original_files for arg in ('-f', path)] + ['-f', str(overrides[service])])
        rollback = f.operator.checked_override(p, p['baseImages'], rollback=True)
        for path in rollback.values():
            env = next(iter(json.loads(path.read_text())['services'].values()))['environment']
            self.assertNotIn('AVA_SELF_REGISTRATION_ENABLED', env)

    def test_new_env_from_disk_is_rejected(self):
        f = self.fixture()
        p = f.operator.capture()
        p['baselineConfig']['provisioning_worker']['environment']['UNREVIEWED'] = 'value'
        with self.assertRaisesRegex(RuntimeError, 'ENV_ADDED_ON_DISK'):
            f.operator.checked_override(p, p['baseImages'])

    def test_feature_configuration_requires_worker_origin_client_and_shared_broker(self):
        f = self.fixture()
        cases = (
            ('provisioning_worker', 'WHATSAPP_CRM_PUBLIC_URL', None, 'RECOVERY_ORIGIN_CLIENT_CONFIGURATION_INVALID'),
            ('provisioning_worker', 'AVA_OIDC_CLIENT_ID', None, 'RECOVERY_ORIGIN_CLIENT_CONFIGURATION_INVALID'),
            ('provisioning_worker', 'AVA_OIDC_ISSUER', 'https://unexpected.invalid/realms/ava', 'RECOVERY_ORIGIN_CLIENT_CONFIGURATION_INVALID'),
            ('provisioning_worker', 'AVA_IDENTITY_ADMIN_CLIENT_SECRET', '', 'WORKER_IDENTITY_CONFIGURATION_INVALID'),
            ('provisioning_worker', 'AVA_PROCESS_ROLE', 'crm', 'WORKER_IDENTITY_CONFIGURATION_INVALID'),
            ('provisioning_worker', 'AVA_IDENTITY_BROKER_TOKEN', 'different-' + 'x' * 32, 'IDENTITY_BROKER_CONFIGURATION_MISMATCH'),
            (op.CRM, 'AVA_IDENTITY_BROKER_TOKEN', 'short', 'IDENTITY_BROKER_CONFIGURATION_MISMATCH'),
            (op.CRM, 'SESSION_SECRET', 'short', 'CRM_IDENTITY_CONFIGURATION_INVALID'),
            (op.CRM, 'AVA_CUSTOMER_ACCESS_ENABLED', 'false', 'CRM_IDENTITY_CONFIGURATION_INVALID'),
        )
        for service, key, value, error in cases:
            rows = copy.deepcopy(f.rows)
            env = op.envmap(rows[service])
            if value is None:
                env.pop(key)
            else:
                env[key] = value
            rows[service]['Config']['Env'] = [k + '=' + v for k, v in env.items()]
            with self.subTest(service=service, key=key), mock.patch.object(f.operator, 'rows', return_value=rows):
                with self.assertRaisesRegex(RuntimeError, error):
                    f.operator.prepare()
        self.assertFalse(any(cmd[1] in ('tag', 'build') for cmd in f.commands))
        self.assertFalse(f.ups)

    def test_feature_configuration_uses_explicit_reviewed_overlay(self):
        f = self.fixture()
        worker = f.rows['provisioning_worker']
        worker['Config']['Env'] = [entry for entry in worker['Config']['Env']
                                   if not entry.startswith(('WHATSAPP_CRM_PUBLIC_URL=', 'AVA_OIDC_CLIENT_ID='))]
        f.operator.m['services']['provisioning_worker']['environment'].update({
            'WHATSAPP_CRM_PUBLIC_URL': 'https://wh.meludtech.tech', 'AVA_OIDC_CLIENT_ID': 'ava-web'})
        f.operator.validate_feature_configuration(f.rows)

    def test_no_redirect_audit_accepts_worker_without_origin_or_client(self):
        f = self.fixture()
        worker = f.rows['provisioning_worker']
        worker['Config']['Env'] = [entry for entry in worker['Config']['Env']
                                   if not entry.startswith(('WHATSAPP_CRM_PUBLIC_URL=', 'AVA_OIDC_CLIENT_ID='))]
        f.operator.m['services']['provisioning_worker']['environment']['AVA_PASSWORD_RECOVERY_NO_REDIRECT'] = 'true'
        with contextlib.redirect_stdout(io.StringIO()):
            f.operator.audit()
        self.assertFalse(any(cmd[1] in ('tag', 'build', 'stop', 'compose') and
                             ('up' in cmd or cmd[1] != 'compose') for cmd in f.commands))
        self.assertFalse(f.ups)

    def test_no_redirect_feature_gate_keeps_issuer_and_crm_redirect_requirements(self):
        f = self.fixture()
        f.operator.m['services']['provisioning_worker']['environment']['AVA_PASSWORD_RECOVERY_NO_REDIRECT'] = 'true'
        for service, key in [('provisioning_worker', 'AVA_OIDC_ISSUER'),
                             (op.CRM, 'WHATSAPP_CRM_PUBLIC_URL'), (op.CRM, 'AVA_OIDC_CLIENT_ID')]:
            rows = copy.deepcopy(f.rows)
            rows[service]['Config']['Env'] = [entry for entry in rows[service]['Config']['Env']
                                             if not entry.startswith(key + '=')]
            with self.subTest(service=service, key=key), self.assertRaisesRegex(
                    RuntimeError, 'RECOVERY_ORIGIN_CLIENT_CONFIGURATION_INVALID'):
                f.operator.validate_feature_configuration(rows)

    def test_worker_without_origin_client_requires_explicit_no_redirect_manifest_flag(self):
        f = self.fixture()
        rows = copy.deepcopy(f.rows)
        rows['provisioning_worker']['Config']['Env'] = [entry for entry in rows['provisioning_worker']['Config']['Env']
            if not entry.startswith(('WHATSAPP_CRM_PUBLIC_URL=', 'AVA_OIDC_CLIENT_ID='))]
        for flag in (None, 'false'):
            env = f.operator.m['services']['provisioning_worker']['environment']
            env.pop('AVA_PASSWORD_RECOVERY_NO_REDIRECT', None)
            if flag is not None:
                env['AVA_PASSWORD_RECOVERY_NO_REDIRECT'] = flag
            with self.subTest(flag=flag), self.assertRaisesRegex(RuntimeError, 'RECOVERY_ORIGIN_CLIENT_CONFIGURATION_INVALID'):
                f.operator.validate_feature_configuration(rows)

    def test_online_backup_includes_wal_and_is_standalone_private(self):
        f = self.fixture()
        self.assertTrue(pathlib.Path(str(f.db) + '-wal').is_file())
        target = f.root / 'backup.db'
        receipt = op.online_backup(f.db, target)
        with contextlib.closing(sqlite3.connect(target)) as db:
            self.assertEqual(db.execute('SELECT * FROM messages').fetchall(), [(1, 'from WAL')])
            self.assertEqual(db.execute('PRAGMA journal_mode').fetchone(), ('delete',))
        self.assertEqual(f.connection.execute('PRAGMA journal_mode').fetchone(), ('wal',))
        f.connection.execute("INSERT INTO messages VALUES(2,'after backup')")
        f.connection.commit()
        self.assertEqual(op.schema_and_rows(target)['tables']['messages']['count'], 1)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(receipt['sha256'], op.sha(target))

    def test_additive_migration_preserves_schema_rows_and_is_idempotent(self):
        f = self.fixture()
        before = op.schema_and_rows(f.db)
        f.connection.executescript(f.ddl)
        after = op.schema_and_rows(f.db)
        op.assert_additive(before, after, f.manifest['allowedNewSchema'])
        f.connection.executescript(f.ddl)
        op.assert_additive(after, op.schema_and_rows(f.db), f.manifest['allowedNewSchema'])
        with self.assertRaisesRegex(RuntimeError, 'UNEXPECTED_SCHEMA_ADDITIONS'):
            op.assert_additive(before, after, f.manifest['allowedNewSchema'][:1])
        f.connection.execute("UPDATE messages SET body='lost original row'")
        f.connection.commit()
        with self.assertRaisesRegex(RuntimeError, 'ORIGINAL_ROWS_CHANGED'):
            op.assert_additive(before, op.schema_and_rows(f.db), f.manifest['allowedNewSchema'])

    def test_readiness_accepts_worker_without_healthcheck_but_rejects_restarts(self):
        f = self.fixture()
        row = copy.deepcopy(f.rows['provisioning_worker'])
        f.operator.ready(row)
        for change, error in (({'RestartCount': 1}, 'SERVICE_NOT_STABLE'),
                ({'State': {**row['State'], 'Health': {'Status': 'starting'}}}, 'SERVICE_NOT_HEALTHY')):
            changed = {**row, **change}
            with self.assertRaisesRegex(RuntimeError, error):
                f.operator.ready(changed)
        f.operator.run = mock.Mock(return_value='{"ready": false}')
        with self.assertRaisesRegex(RuntimeError, 'SERVICE_NOT_READY'):
            f.operator.ready(row)

    def test_candidate_worker_probe_requires_explicit_full_initialization_contract(self):
        f = self.fixture()
        row = copy.deepcopy(f.rows['provisioning_worker'])
        f.operator.ready(row)
        self.assertEqual(f.commands[-1][-1], op.READINESS_JS)
        f.operator.ready(row, require_worker_ready=True)
        self.assertEqual(f.commands[-1][-1], op.CANDIDATE_READINESS_JS)
        f.operator.run = mock.Mock(return_value='{"ready": false}')
        with self.assertRaisesRegex(RuntimeError, '^SERVICE_NOT_READY$'):
            f.operator.ready(row, require_worker_ready=True)

    def test_apply_and_rollback_choose_candidate_and_original_worker_probes(self):
        f = self.fixture()
        with self.quiet(), mock.patch.object(op.time, 'sleep'):
            f.operator.prepare()
            p = f.operator.load()
            f.operator.apply()
            f.operator.rollback()
        worker_probes = [probe for probe in f.probes if probe[0] == 'provisioning_worker']
        self.assertTrue(any(image == p['candidateImages']['provisioning_worker'] for _, image, _ in worker_probes))
        self.assertTrue(any(image == p['baseImages']['provisioning_worker'] for _, image, _ in worker_probes))
        for _, image, script in worker_probes:
            expected = op.CANDIDATE_READINESS_JS if image == p['candidateImages']['provisioning_worker'] else op.READINESS_JS
            self.assertEqual(script, expected)
        self.assertTrue(all(script == op.READINESS_JS for service, _, script in f.probes if service == op.CRM))

    def test_docker_logs_include_stderr_for_hash_only_failure_diagnostics(self):
        f = self.fixture()
        proc = types.SimpleNamespace(returncode=0, stdout='stdout-fixture-secret', stderr='stderr-fixture-secret')
        with mock.patch.object(op.subprocess, 'run', return_value=proc):
            output = op.Operator.run(f.operator, ['docker', 'logs', '--tail', '200', 'worker-fixture'])
            normal = op.Operator.run(f.operator, ['docker', 'inspect', 'worker-fixture'])
        self.assertIn(proc.stdout, output)
        self.assertIn(proc.stderr, output)
        self.assertEqual(normal, proc.stdout)

    def test_failure_diagnostics_error_does_not_prevent_automatic_rollback(self):
        f = self.fixture()
        with self.quiet():
            f.operator.prepare()
        f.fail_up_once = 'provisioning_worker'
        f.operator.capture_apply_failure = mock.Mock(side_effect=RuntimeError('SYNTHETIC_DIAGNOSTICS_FAILED'))
        with self.quiet(), mock.patch.object(op.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, '^APPLY_FAILED_ROLLED_BACK_DATABASE_RETAINED$'):
                f.operator.apply()
        f.operator.capture_apply_failure.assert_called_once()
        self.assertEqual([row[0] for row in f.ups], ['provisioning_worker', op.CRM, 'provisioning_worker'])
        for service in op.SERVICES:
            self.assertEqual(f.rows[service]['Image'], f.manifest['services'][service]['baseImageId'])

    def test_original_apply_failure_survives_rollback_generic_error_log_overwrite(self):
        f = self.fixture()
        with self.quiet():
            f.operator.prepare()
        original = {'commandFamily': ['docker', 'compose'], 'returncode': 42,
                    'stdoutSha256': hashed('original-stdout-private-secret'),
                    'stderrSha256': hashed('original-worker-start-private-secret')}
        rollback = {'commandFamily': ['docker', 'exec'], 'returncode': 1,
                    'stdoutSha256': hashed('rollback-transient-private-secret'),
                    'stderrSha256': hashed('rollback-readiness-private-secret')}
        f.logs['provisioning_worker'] = 'MODULE_NOT_FOUND secret-password-in-log\nSQLITE_BUSY secret-token-in-log'
        f.fail_up_once = 'provisioning_worker'
        failed = False
        run = f.run
        def fail_then_overwrite(args, **kwargs):
            nonlocal failed
            if failed and args[1] == 'compose' and 'up' in args and args[-1] == op.CRM:
                op.private_json(f.operator.root / 'command-failure.private.json', rollback)
            try:
                return run(args, **kwargs)
            except RuntimeError as error:
                if str(error) == 'SYNTHETIC_COMPOSE_FAILURE':
                    failed = True
                    worker = f.rows['provisioning_worker']
                    worker['Image'] = f.tags['ava-registration-worker:fixture']
                    worker['Id'] = 'failed-start-worker'
                    worker['State'].update(Running=False, ExitCode=78, OOMKilled=False)
                    op.private_json(f.operator.root / 'command-failure.private.json', original)
                    raise RuntimeError('COMMAND_FAILED_PRIVATE_LOG') from None
                raise
        f.operator.run = fail_then_overwrite
        with self.quiet(), mock.patch.object(op.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, '^APPLY_FAILED_ROLLED_BACK_DATABASE_RETAINED$'):
                f.operator.apply()
        path = f.operator.root / 'apply-failure.private.json'
        report = json.loads(path.read_text())
        self.assertEqual(report['reason'], 'COMMAND_FAILED_PRIVATE_LOG')
        self.assertEqual(report['lastCommandFailure'], original)
        self.assertEqual(report['stage']['service'], 'provisioning_worker')
        self.assertFalse(report['stage']['rollback'])
        self.assertRegex(report['stage']['phase'], '(compose|up)')
        self.assertEqual(json.loads((f.operator.root / 'command-failure.private.json').read_text()), rollback)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        serialized = path.read_text()
        for secret in ('original-stdout-private-secret', 'original-worker-start-private-secret',
                       'rollback-transient-private-secret', 'secret-password-in-log', 'secret-token-in-log',
                       'fixture-secret-value', 'ADMIN_PASSWORD_HASH', 'Config', 'Env'):
            self.assertNotIn(secret, serialized)
        def dictionaries(value):
            if isinstance(value, dict):
                yield value
                for child in value.values():
                    yield from dictionaries(child)
            elif isinstance(value, list):
                for child in value:
                    yield from dictionaries(child)
        log_entries = [value for value in dictionaries(report) if 'logsSha256' in value]
        self.assertTrue(log_entries)
        self.assertIn(hashed(f.logs['provisioning_worker']), {value['logsSha256'] for value in log_entries})
        self.assertTrue(all(isinstance(value['knownLogCodes'], list) for value in log_entries))
        worker = report['runtime']['provisioning_worker']
        self.assertEqual(worker['containerId'], 'failed-start-worker')
        self.assertEqual(worker['exitCode'], 78)
        self.assertFalse(worker['running'])
        self.assertEqual(set(worker['knownLogCodes']), {'MODULE_NOT_FOUND', 'SQLITE_BUSY'})
        self.assertEqual(set(worker) - {'startupDiagnostics'}, {'containerId', 'imageId', 'running', 'restarting', 'exitCode',
            'oomKilled', 'restartCount', 'dockerHealth', 'logsSha256', 'knownLogCodes'})

    def test_worker_readiness_failure_is_captured_before_rollback_stages(self):
        f = self.fixture()
        with self.quiet():
            f.operator.prepare()
        run = f.run
        def never_ready(args, **kwargs):
            result = run(args, **kwargs)
            if args[1] == 'exec' and args[-1] == op.CANDIDATE_READINESS_JS:
                f.rows['provisioning_worker']['RestartCount'] = 1
                return '{"ready": false}'
            return result
        f.operator.run = never_ready
        with self.quiet(), mock.patch.object(op.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, '^APPLY_FAILED_ROLLED_BACK_DATABASE_RETAINED$'):
                f.operator.apply()
        report = json.loads((f.operator.root / 'apply-failure.private.json').read_text())
        self.assertEqual(report['reason'], 'SERVICE_READINESS_TIMEOUT')
        self.assertEqual(report['stage']['service'], 'provisioning_worker')
        self.assertFalse(report['stage']['rollback'])
        self.assertIn('read', report['stage']['phase'])
        self.assertEqual([row[0] for row in f.ups], ['provisioning_worker', op.CRM, 'provisioning_worker'])

    def test_failure_capture_rejects_raw_command_fields_and_sanitizes_log_fetch_error(self):
        f = self.fixture()
        with self.quiet():
            f.operator.prepare()
        p = f.operator.load()
        worker = f.rows['provisioning_worker']
        worker['Image'] = p['candidateImages']['provisioning_worker']
        op.private_json(f.operator.root / 'command-failure.private.json', {
            'commandFamily': ['docker', 'compose'], 'returncode': 1,
            'stdoutSha256': hashed('safe-output'), 'stderrSha256': hashed('safe-error'),
            'stderr': 'raw-command-password-private'})
        f.operator.set_stage('readiness', service='provisioning_worker')
        run = f.run
        def logs_unavailable(args, **kwargs):
            if args[1] == 'logs':
                raise RuntimeError('log-fetch-password-private')
            return run(args, **kwargs)
        f.operator.run = logs_unavailable
        f.operator.capture_apply_failure(p, RuntimeError('exception-password-private'))
        report = json.loads((f.operator.root / 'apply-failure.private.json').read_text())
        self.assertEqual(report['reason'], 'APPLY_STAGE_FAILED')
        self.assertNotIn('lastCommandFailure', report)
        self.assertTrue(report['runtime']['provisioning_worker']['logsUnavailable'])
        self.assertNotIn('logsSha256', report['runtime']['provisioning_worker'])
        self.assertNotIn('password-private', json.dumps(report))

    def captured_startup_diagnostics(self, lines):
        f = self.fixture()
        with self.quiet():
            f.operator.prepare()
        p = f.operator.load()
        f.rows['provisioning_worker']['Image'] = p['candidateImages']['provisioning_worker']
        logs = '\n'.join(line if isinstance(line, str) else json.dumps(line) for line in lines)
        f.logs['provisioning_worker'] = logs
        f.operator.set_stage('readiness', service='provisioning_worker')
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            f.operator.capture_apply_failure(p, RuntimeError('SERVICE_READINESS_TIMEOUT'))
        path = f.operator.root / 'apply-failure.private.json'
        report = json.loads(path.read_text())
        info = report['runtime']['provisioning_worker']
        self.assertEqual(info['logsSha256'], hashed(logs))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(stdout.getvalue(), '')
        return info.get('startupDiagnostics', []), path.read_text()

    def test_startup_diagnostics_retain_safe_source_and_strip_all_extra_fields(self):
        record = {'event': 'PROVISIONING_WORKER_START_FAILED', 'phase': 'IDENTITY_SCHEMA',
                  'code': 'SQLITE_CONSTRAINT', 'source': {'path': 'src/services/identity/identity-store.js', 'line': 42},
                  'message': 'raw-message-secret', 'stack': 'raw-stack-secret',
                  'env': {'password': 'raw-env-secret'}, 'sql': 'raw-sql-secret'}
        boundary = {'event': record['event'], 'phase': 'BOOTSTRAP', 'code': 'ENOENT',
                    'source': {'path': 'src/' + 'a' * 173 + '.js', 'line': 2147483647}}
        diagnostics, receipt = self.captured_startup_diagnostics([record, boundary, 'unstructured raw-log-secret'])
        self.assertEqual(diagnostics, [{key: record[key] for key in ('event', 'phase', 'code', 'source')}, boundary])
        for value in ('raw-message-secret', 'raw-stack-secret', 'raw-env-secret', 'raw-sql-secret', 'raw-log-secret'):
            self.assertNotIn(value, receipt)

    def test_startup_diagnostics_accept_concrete_phases_and_error_code_allowlist(self):
        phases = ['DB_INIT', 'IDENTITY_SCHEMA', 'SALES_SCHEMA', 'BROKER_BIND', 'LOAD_REVOCATION',
                  'LOAD_PASSWORD_RECOVERY', 'LOAD_REGISTRATION', 'IDENTITY_TIMER', 'LOAD_SYNC_RECOVERY',
                  'SYNC_RECOVERY_TIMER', 'LOAD_PROVISIONING', 'PROVISIONING_POLLER', 'READY', 'BOOTSTRAP']
        for start in range(0, len(phases), 4):
            records = [{'event': 'PROVISIONING_WORKER_START_FAILED', 'phase': phase, 'code': 'WORKER_STARTUP_FAILED'}
                       for phase in phases[start:start + 4]]
            with self.subTest(phases=phases[start:start + 4]):
                diagnostics, _ = self.captured_startup_diagnostics(records)
                self.assertEqual(diagnostics, records)
        codes = ['SQLITE_BUSY', 'ERR_DLOPEN_FAILED', 'MODULE_NOT_FOUND', 'EADDRINUSE', 'EACCES', 'ENOENT',
                 'IDENTITY_SCHEMA_MISSING', 'WORKER_STARTUP_FAILED', 'SQLITE_' + 'A' * 73]
        for start in range(0, len(codes), 4):
            records = [{'event': 'PROVISIONING_WORKER_START_FAILED', 'phase': 'BOOTSTRAP', 'code': code}
                       for code in codes[start:start + 4]]
            with self.subTest(codes=codes[start:start + 4]):
                diagnostics, _ = self.captured_startup_diagnostics(records)
                self.assertEqual(diagnostics, records)

    def test_startup_diagnostics_filter_invalid_phase_code_and_non_json_records(self):
        valid = {'event': 'PROVISIONING_WORKER_START_FAILED', 'phase': 'DB_INIT', 'code': 'SQLITE_BUSY'}
        invalid = [
            {**valid, 'event': 'OTHER_EVENT'}, {**valid, 'phase': 'SECRET_UNREVIEWED_PHASE'},
            {**valid, 'phase': None}, {**valid, 'phase': ['DB_INIT']},
            {**valid, 'code': 'secret-error-message'}, {**valid, 'code': 'SQLITE_BUSY private-secret'},
            {**valid, 'code': 'SQLITE_' + 'A' * 74}, {**valid, 'code': 'ERR_123'},
            {**valid, 'code': {'secret': 'private-secret'}}, {**valid, 'code': None},
            {'event': valid['event'], 'phase': valid['phase']},
            '[1,2,3]', 'null', '42', 'not json raw-log-secret', valid,
        ]
        diagnostics, receipt = self.captured_startup_diagnostics(invalid)
        self.assertEqual(diagnostics, [valid])
        self.assertNotIn('private-secret', receipt)
        self.assertNotIn('raw-log-secret', receipt)

    def test_startup_diagnostics_reject_invalid_source_instead_of_copying_it(self):
        valid = {'event': 'PROVISIONING_WORKER_START_FAILED', 'phase': 'LOAD_REGISTRATION',
                 'code': 'MODULE_NOT_FOUND', 'source': {'path': 'provisioning-worker.js', 'line': 1}}
        sources = [None, 'secret-source', {}, {'path': 'provisioning-worker.js'},
            {'path': 'provisioning-worker.js', 'line': 1, 'secret': 'private-source-secret'},
            {'path': '../secret.js', 'line': 1}, {'path': 'src/../secret.js', 'line': 1},
            {'path': 'src/services/../../secret.js', 'line': 1}, {'path': '/src/secret.js', 'line': 1},
            {'path': 'src/secret.json', 'line': 1}, {'path': 'src/' + 'a' * 174 + '.js', 'line': 1},
            {'path': 'provisioning-worker.js', 'line': 0}, {'path': 'provisioning-worker.js', 'line': -1},
            {'path': 'provisioning-worker.js', 'line': True}, {'path': 'provisioning-worker.js', 'line': False},
            {'path': 'provisioning-worker.js', 'line': '1'}, {'path': 'provisioning-worker.js', 'line': 1.5},
            {'path': 'src/secret.js\nprivate-source-secret', 'line': 1}]
        diagnostics, receipt = self.captured_startup_diagnostics([{**valid, 'source': source} for source in sources] + [valid])
        self.assertEqual(diagnostics, [valid])
        self.assertNotIn('private-source-secret', receipt)
        self.assertNotIn('secret-source', receipt)

    def test_startup_diagnostics_only_scan_last_200_lines_and_keep_at_most_four(self):
        outside = {'event': 'PROVISIONING_WORKER_START_FAILED', 'phase': 'DB_INIT', 'code': 'SQLITE_BUSY'}
        recent = {'event': 'PROVISIONING_WORKER_START_FAILED', 'phase': 'READY', 'code': 'WORKER_STARTUP_FAILED'}
        diagnostics, _ = self.captured_startup_diagnostics([outside] + ['ignored unstructured line'] * 199 + [recent])
        self.assertEqual(diagnostics, [recent])
        records = [{**recent, 'source': {'path': 'provisioning-worker.js', 'line': number}} for number in range(1, 8)]
        diagnostics, _ = self.captured_startup_diagnostics(records)
        self.assertEqual(len(diagnostics), 4)
        self.assertTrue(all(record in records for record in diagnostics))

    def test_runner_rehashes_bytes_immediately_before_execution(self):
        f = self.fixture()
        runner = f.bundle / f.manifest['migrationRunner']['path']
        runner.write_text('// modified after constructor')
        commands_before = len(f.commands)
        with self.assertRaisesRegex(RuntimeError, 'RUNNER_CHANGED'):
            f.operator.runner(f.rows[op.CRM]['Image'], f.db)
        self.assertEqual(len(f.commands), commands_before)

    def test_public_routes_and_assets_require_exact_candidate_bytes(self):
        f = self.fixture()
        assets = {'index.html': b'candidate HTML', 'assets/register.js': b'candidate registration bundle'}
        hashes = {'frontend/dist/' + name: hashlib.sha256(value).hexdigest() for name, value in assets.items()}
        urls = []
        def fetch(request, timeout):
            urls.append(request.full_url)
            response = mock.MagicMock()
            response.status = 200
            response.geturl.return_value = request.full_url
            path = request.full_url.removeprefix(f.manifest['publicBaseUrl']).lstrip('/')
            response.read.return_value = assets.get(path, assets['index.html'])
            response.__enter__.return_value = response
            return response
        with mock.patch.object(op.urllib.request, 'urlopen', side_effect=fetch):
            receipt = op.Operator.public(f.operator, hashes)
        self.assertEqual(urls[:3], [f.manifest['publicBaseUrl'] + route for route in ['/login', '/register', '/forgot-password']])
        self.assertEqual(receipt['fileCount'], 2)
        self.assertIn(f.manifest['publicBaseUrl'] + '/assets/register.js', urls)

    def test_public_route_redirect_or_wrong_bytes_fail_verification(self):
        f = self.fixture()
        hashes = {'frontend/dist/index.html': hashed('reviewed frontend')}
        for redirect, body, error in ((True, b'reviewed frontend', 'PUBLIC_HTTPS_RESPONSE_CHANGED'),
                (False, b'stale frontend', 'PUBLIC_ROUTE_BYTES_MISMATCH')):
            response = mock.MagicMock()
            response.status = 200
            response.geturl.return_value = f.manifest['publicBaseUrl'] + ('/somewhere-else' if redirect else '/login')
            response.read.return_value = body
            response.__enter__.return_value = response
            with self.subTest(error=error), mock.patch.object(op.urllib.request, 'urlopen', return_value=response):
                with self.assertRaisesRegex(RuntimeError, error):
                    op.Operator.public(f.operator, hashes)

    def test_audit_is_read_only(self):
        f = self.fixture()
        before = op.schema_and_rows(f.db)
        with self.quiet():
            f.operator.audit()
        self.assertEqual(op.schema_and_rows(f.db), before)
        self.assertFalse(f.ups)
        self.assertFalse(any(cmd[1] in ('build', 'tag') for cmd in f.commands))
        self.assertFalse(list(f.operator.root.glob('*backup*')))

    def test_keycloak_failure_blocks_prepare_before_build_and_apply_before_database_write(self):
        f = self.fixture()
        f.operator.keycloak_check.side_effect = RuntimeError('KEYCLOAK_RELEASE_STATE_DRIFT')
        before = op.schema_and_rows(f.db)
        with self.assertRaisesRegex(RuntimeError, 'KEYCLOAK_RELEASE_STATE_DRIFT'):
            f.operator.prepare()
        self.assertFalse(any(cmd[1] in ('tag', 'build') for cmd in f.commands))
        self.assertFalse(f.ups)
        f.operator.keycloak_check.side_effect = None
        with self.quiet():
            f.operator.prepare()
        f.operator.keycloak_check.side_effect = RuntimeError('KEYCLOAK_SMTP_PROBE_FAILED')
        backup_count = len(list(f.operator.root.glob('*backup*')))
        with self.assertRaisesRegex(RuntimeError, 'KEYCLOAK_SMTP_PROBE_FAILED'):
            f.operator.apply()
        f.operator.keycloak_check.assert_called_with(applied=True)
        self.assertEqual(len(list(f.operator.root.glob('*backup*'))), backup_count)
        self.assertEqual(op.schema_and_rows(f.db), before)
        self.assertFalse(f.ups)

    def test_actual_keycloak_gate_requires_applied_client_and_smtp(self):
        f = self.fixture()
        f.operator.args.keycloak_state = pathlib.Path('/fake/private/keycloak-state.json')
        before, after = {'redirectUris': ['existing']}, {'redirectUris': ['existing', 'required']}
        kc = mock.Mock()
        kc.load.return_value = {'before': before, 'after': after}
        kc.read_client.return_value = before
        module = types.SimpleNamespace(KeycloakOperator=mock.Mock(return_value=kc))
        spec = types.SimpleNamespace(loader=mock.Mock())
        with mock.patch('importlib.util.spec_from_file_location', return_value=spec), \
                mock.patch('importlib.util.module_from_spec', return_value=module):
            op.Operator.keycloak_check(f.operator)
            kc.smtp.assert_called_once()
            kc.smtp.reset_mock()
            with self.assertRaisesRegex(RuntimeError, 'KEYCLOAK_RELEASE_STATE_DRIFT'):
                op.Operator.keycloak_check(f.operator, applied=True)
            kc.smtp.assert_not_called()
            kc.read_client.return_value = after
            op.Operator.keycloak_check(f.operator, applied=True)
            kc.smtp.assert_called_once()

    def test_explicit_worker_no_redirect_mode_bypasses_keycloak_admin_only(self):
        f = self.fixture()
        f.operator.m['services']['provisioning_worker']['environment']['AVA_PASSWORD_RECOVERY_NO_REDIRECT'] = 'true'
        self.assertTrue(f.operator.no_redirect_recovery())
        with mock.patch('importlib.util.spec_from_file_location', side_effect=AssertionError('Keycloak admin must not be loaded')):
            for applied in (False, True):
                result = op.Operator.keycloak_check(f.operator, applied=applied)
                self.assertFalse(result['clientMutationRequired'])
                self.assertEqual(result['smtpReadiness'], 'unverified')
                self.assertFalse(result['mailSent'])

    def test_false_unset_and_crm_only_no_redirect_flags_keep_strict_keycloak_gate(self):
        for worker_flag, crm_flag in ((None, None), ('false', None), ('TRUE', None), (True, None), (None, 'true')):
            with self.subTest(worker_flag=worker_flag, crm_flag=crm_flag):
                f = self.fixture()
                worker_env = f.operator.m['services']['provisioning_worker']['environment']
                crm_env = f.operator.m['services'][op.CRM]['environment']
                if worker_flag is not None:
                    worker_env['AVA_PASSWORD_RECOVERY_NO_REDIRECT'] = worker_flag
                if crm_flag is not None:
                    crm_env['AVA_PASSWORD_RECOVERY_NO_REDIRECT'] = crm_flag
                self.assertFalse(f.operator.no_redirect_recovery())
                f.operator.args.keycloak_state = pathlib.Path('/fake/private/keycloak-state.json')
                client = {'redirectUris': ['existing', 'required']}
                kc = mock.Mock()
                kc.load.return_value = {'before': client, 'after': client}
                kc.read_client.return_value = client
                ctor = mock.Mock(return_value=kc)
                module = types.SimpleNamespace(KeycloakOperator=ctor)
                spec = types.SimpleNamespace(loader=mock.Mock())
                with mock.patch('importlib.util.spec_from_file_location', return_value=spec), \
                        mock.patch('importlib.util.module_from_spec', return_value=module):
                    op.Operator.keycloak_check(f.operator, applied=True)
                ctor.assert_called_once()
                kc.read_client.assert_called_once()
                kc.smtp.assert_called_once()

    def test_no_redirect_smoke_control_env_and_proof_are_required_for_each_image(self):
        f = self.fixture()
        f.operator.m['services']['provisioning_worker']['environment']['AVA_PASSWORD_RECOVERY_NO_REDIRECT'] = 'true'
        with self.quiet():
            f.operator.prepare()
        p = f.operator.load()
        smoke_commands = [cmd for cmd in f.commands if cmd[-1] == 'smoke']
        self.assertEqual(len(smoke_commands), 2)
        for service in op.SERVICES:
            command = next(cmd for cmd in smoke_commands if p['candidateImages'][service] in cmd)
            self.assertIn('AVA_RELEASE_RECOVERY_NO_REDIRECT=1', command)
            self.assertEqual(command[command.index('--network') + 1], 'none')
        receipt = json.loads((f.operator.root / 'prepared.receipt.json').read_text())
        self.assertTrue(receipt['migration']['noRedirectRecoveryContractVerified'])
        self.assertFalse(f.ups)

    def test_no_redirect_missing_or_nonboolean_contract_proof_blocks_release(self):
        for proof in (None, False, 'true', 1):
            with self.subTest(proof=proof):
                f = self.fixture()
                f.operator.m['services']['provisioning_worker']['environment']['AVA_PASSWORD_RECOVERY_NO_REDIRECT'] = 'true'
                run = f.run
                def unproven(args, **kwargs):
                    result = run(args, **kwargs)
                    if args[-1] == 'smoke':
                        receipt = {'contractVerified': True}
                        if proof is not None:
                            receipt['noRedirectRecoveryContractVerified'] = proof
                        return json.dumps(receipt)
                    return result
                f.operator.run = unproven
                with self.assertRaisesRegex(RuntimeError, '^NO_REDIRECT_RECOVERY_CONTRACT_UNPROVEN$'):
                    f.operator.prepare()
                self.assertFalse(f.ups)
                self.assertNotIn('ava_self_registrations', op.schema_and_rows(f.db)['tables'])

    def test_no_redirect_worker_smoke_proof_is_checked_after_crm_proof(self):
        f = self.fixture()
        f.operator.m['services']['provisioning_worker']['environment']['AVA_PASSWORD_RECOVERY_NO_REDIRECT'] = 'true'
        run = f.run
        def worker_unproven(args, **kwargs):
            result = run(args, **kwargs)
            worker_image = f.tags.get('ava-registration-worker:fixture')
            if args[-1] == 'smoke' and worker_image in args:
                return json.dumps({'contractVerified': True})
            return result
        f.operator.run = worker_unproven
        with self.assertRaisesRegex(RuntimeError, '^NO_REDIRECT_RECOVERY_CONTRACT_UNPROVEN$'):
            f.operator.prepare()
        self.assertEqual(len([cmd for cmd in f.commands if cmd[-1] == 'smoke']), 2)
        self.assertFalse(f.ups)

    def test_strict_recovery_does_not_claim_no_redirect_smoke_proof(self):
        f = self.fixture()
        with self.quiet():
            f.operator.prepare()
        receipt = json.loads((f.operator.root / 'prepared.receipt.json').read_text())
        self.assertFalse(receipt['migration']['noRedirectRecoveryContractVerified'])
        for command in f.commands:
            if command[-1] == 'smoke':
                self.assertNotIn('AVA_RELEASE_RECOVERY_NO_REDIRECT=1', command)

    def test_replaced_database_inode_blocks_apply_and_rollback(self):
        f = self.fixture()
        with self.quiet():
            f.operator.prepare()
        f.connection.close()
        replacement = f.root / 'replacement.db'
        op.online_backup(f.db, replacement)
        replacement.replace(f.db)
        for action in (f.operator.apply, f.operator.rollback):
            with self.subTest(action=action.__name__), self.assertRaisesRegex(RuntimeError, 'DATABASE_INODE_DRIFT'):
                action()
        self.assertFalse(f.ups)
        self.assertNotIn('release_accounts', op.schema_and_rows(f.db)['tables'])

    def test_command_failure_records_only_output_hashes_not_secret_bytes(self):
        f = self.fixture()
        failed = types.SimpleNamespace(returncode=1, stdout='stdout-secret-token', stderr='stderr-secret-password')
        stdout = io.StringIO()
        with mock.patch.object(op.subprocess, 'run', return_value=failed), contextlib.redirect_stdout(stdout):
            with self.assertRaisesRegex(RuntimeError, '^COMMAND_FAILED_PRIVATE_LOG$'):
                op.Operator.run(f.operator, ['docker', 'inspect', 'argument-secret'])
        path = f.operator.root / 'command-failure.private.json'
        data = path.read_text()
        value = json.loads(data)
        self.assertEqual(value['stdoutSha256'], hashed(failed.stdout))
        self.assertEqual(value['stderrSha256'], hashed(failed.stderr))
        self.assertEqual(value['commandFamily'], ['docker', 'inspect'])
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        for secret in (failed.stdout, failed.stderr, 'argument-secret'):
            self.assertNotIn(secret, data)
            self.assertNotIn(secret, stdout.getvalue())

    def test_full_prepare_apply_and_rollback_retains_new_live_rows_and_both_images(self):
        f = self.fixture()
        with self.quiet(), mock.patch.object(op.time, 'sleep'):
            f.operator.prepare()
            self.assertFalse(f.ups)
            p = f.operator.load()
            for service in op.SERVICES:
                self.assertEqual(p['candidateHashes'][service]['prod-only.js'], p['oldHashes'][service]['prod-only.js'])
            f.operator.apply()
            self.assertEqual([row[0] for row in f.ups], ['provisioning_worker', op.CRM])
            f.connection.execute("INSERT INTO messages VALUES(2,'post release data')")
            f.connection.execute("INSERT INTO release_accounts VALUES(1,'new-account@fixture.invalid')")
            f.connection.commit()
            current = op.schema_and_rows(f.db)
            f.operator.rollback()
        self.assertEqual([row[0] for row in f.ups], ['provisioning_worker', op.CRM, op.CRM, 'provisioning_worker'])
        self.assertEqual(op.schema_and_rows(f.db), current)
        for service in op.SERVICES:
            self.assertEqual(f.rows[service]['Image'], f.manifest['services'][service]['baseImageId'])
            self.assertNotIn('AVA_SELF_REGISTRATION_ENABLED', op.envmap(f.rows[service]))
        for service, _, command in f.ups:
            self.assertEqual(command[-7:], ['up', '-d', '--no-deps', '--pull', 'never', '--force-recreate', service])
            original = p['composeInputs'][service]['command']
            self.assertEqual(command[:len(original)], original)
        receipt = json.loads((f.operator.root / 'rolled_back.receipt.json').read_text())
        self.assertFalse(receipt['databaseRestored'])
        self.assertEqual(f.other[0]['State']['StartedAt'], 'old-start')

    def test_partial_apply_failure_rolls_back_both_images_retaining_additive_db(self):
        f = self.fixture()
        with self.quiet(), mock.patch.object(op.time, 'sleep'):
            f.operator.prepare()
            f.fail_up_once = op.CRM
            with self.assertRaisesRegex(RuntimeError, 'APPLY_FAILED_ROLLED_BACK_DATABASE_RETAINED'):
                f.operator.apply()
        self.assertEqual([row[0] for row in f.ups], ['provisioning_worker', op.CRM, op.CRM, 'provisioning_worker'])
        self.assertIn('release_accounts', op.schema_and_rows(f.db)['tables'])
        self.assertEqual(op.schema_and_rows(f.db)['tables']['messages']['count'], 1)
        for service in op.SERVICES:
            self.assertEqual(f.rows[service]['Image'], f.manifest['services'][service]['baseImageId'])
        receipt = json.loads((f.operator.root / 'rolled_back.receipt.json').read_text())
        self.assertTrue(receipt['automatic'])
        self.assertFalse(receipt['databaseRestored'])

    def test_manual_rollback_works_after_candidate_images_are_pruned(self):
        f = self.fixture()
        with self.quiet(), mock.patch.object(op.time, 'sleep'):
            f.operator.prepare()
            f.operator.apply()
            p = f.operator.load()
            candidates = set(p['candidateImages'].values())
            self.assertTrue(all(row['Image'] in candidates for row in f.rows.values()))
            for image in candidates:
                del f.images[image]
            f.tags = {tag: image for tag, image in f.tags.items() if image not in candidates}
            with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_IMAGE_MISSING'):
                f.operator.load()
            current_database = op.schema_and_rows(f.db)
            f.operator.rollback()
        self.assertEqual(op.schema_and_rows(f.db), current_database)
        self.assertEqual([row[0] for row in f.ups][-2:], list(op.SERVICES))
        for service in op.SERVICES:
            self.assertEqual(f.rows[service]['Image'], p['baseImages'][service])

    def test_rollback_barriers_leave_both_apps_stopped_and_database_retained(self):
        cases = (
            ("INSERT INTO ava_invitations VALUES(1,'self-registration:fixture',10,'active-lease-secret')", 'invitationLease'),
            ("INSERT INTO ava_invitations VALUES(1,'self-registration:fixture',10,'')", 'invitationLease'),
            ("INSERT INTO ava_invitations VALUES(1,'self-registration:fixture',10,NULL); INSERT INTO ava_identity_outbox VALUES(1,10,'pending')", 'pendingRevocation'),
            ("INSERT INTO ava_invitations VALUES(1,'self-registration:fixture',10,NULL); INSERT INTO ava_identity_outbox VALUES(1,10,NULL)", 'pendingRevocation'),
            ("INSERT INTO ava_self_registrations VALUES(1,'enrolling')", 'enrollingRegistration'),
            ("INSERT INTO ava_self_registrations VALUES(1,'completed'); INSERT INTO ava_invitations VALUES(1,'self-registration:fixture',10,NULL); INSERT INTO ava_identity_outbox VALUES(1,10,'retry')", 'pendingRevocation'),
        )
        for sql, barrier in cases:
            with self.subTest(barrier=barrier, sql=sql):
                f = self.applied_fixture()
                f.connection.executescript(sql)
                before = op.schema_and_rows(f.db)
                with self.quiet(), self.assertRaisesRegex(RuntimeError, '^ROLLBACK_IDENTITY_RECONCILIATION_REQUIRED$'):
                    f.operator.rollback()
                self.assertEqual(f.stops, list(op.SERVICES))
                self.assertFalse(any(row['State']['Running'] for row in f.rows.values()))
                self.assertFalse(f.ups)
                self.assertEqual(op.schema_and_rows(f.db), before)
                receipt = json.loads((f.operator.root / 'rollback_blocked.receipt.json').read_text())
                self.assertTrue(receipt['rollbackGate']['barriers'][barrier])
                self.assertFalse(receipt['rollbackGate']['rollbackEligible'])
                self.assertTrue(receipt['bothAppsStopped'])
                self.assertFalse(receipt['databaseRestored'])
                self.assertEqual(receipt['rollbackGate']['gateSha256'], hashed(op.ROLLBACK_ELIGIBILITY_JS))
                self.assertNotIn('active-lease-secret', json.dumps(receipt))

    def test_terminal_registrations_and_done_revocations_allow_ordered_rollback(self):
        f = self.applied_fixture()
        f.connection.executescript("INSERT INTO ava_self_registrations VALUES(1,'completed'),(2,'failed'),(3,'expired'); "
            "INSERT INTO ava_invitations VALUES(1,'self-registration:fixture',10,NULL),(2,'admin',11,'unrelated-lease'); "
            "INSERT INTO ava_identity_outbox VALUES(1,10,'done'),(2,11,'pending');")
        before = op.schema_and_rows(f.db)
        other = copy.deepcopy(f.other)
        with self.quiet(), mock.patch.object(op.time, 'sleep'):
            f.operator.rollback()
        self.assertEqual(f.stops, list(op.SERVICES))
        self.assertEqual([row[0] for row in f.ups], list(op.SERVICES))
        self.assertEqual(op.schema_and_rows(f.db), before)
        self.assertEqual(f.other, other)
        gate_index = next(i for i, cmd in enumerate(f.commands) if cmd[-1] == op.ROLLBACK_ELIGIBILITY_JS)
        stops = [i for i, cmd in enumerate(f.commands) if cmd[1] == 'stop']
        self.assertTrue(all(i < gate_index for i in stops))
        self.assertTrue(all(cmd[-1] in {row['Id'] for row in f.original_rows.values()} or
                            cmd[-1].startswith('recreated-') for cmd in f.commands if cmd[1] == 'stop'))
        receipt = json.loads((f.operator.root / 'rolled_back.receipt.json').read_text())
        self.assertTrue(receipt['rollbackGate']['rollbackEligible'])
        self.assertTrue(receipt['rollbackGate']['ingressAndWorkerQuiesced'])
        self.assertEqual(receipt['rollbackGate']['databaseSha256'], receipt['backup']['sha256'])

    def test_pre_migration_database_without_signups_is_rollback_eligible(self):
        f = self.fixture()
        with self.quiet(), mock.patch.object(op.time, 'sleep'):
            f.operator.prepare()
            self.assertNotIn('ava_self_registrations', op.schema_and_rows(f.db)['tables'])
            f.operator.rollback()
        self.assertEqual(f.stops, list(op.SERVICES))
        self.assertNotIn('ava_self_registrations', op.schema_and_rows(f.db)['tables'])

    def test_missing_or_malformed_identity_schema_fails_closed_after_stop(self):
        for sql in ('DROP TABLE ava_identity_outbox',
                'ALTER TABLE ava_invitations RENAME COLUMN leaseToken TO wrongColumn',
                'ALTER TABLE ava_self_registrations RENAME COLUMN state TO wrongColumn',
                "DROP TABLE ava_self_registrations; INSERT INTO ava_invitations VALUES(1,'self-registration:fixture',10,NULL)",
                'DROP TABLE ava_self_registrations; CREATE VIEW ava_self_registrations AS SELECT 1 AS state'):
            with self.subTest(sql=sql):
                f = self.applied_fixture()
                f.connection.executescript(sql)
                before = op.schema_and_rows(f.db)
                with self.quiet(), self.assertRaisesRegex(RuntimeError, '^ROLLBACK_ELIGIBILITY_SCHEMA_INVALID$'):
                    f.operator.rollback()
                self.assertFalse(any(row['State']['Running'] for row in f.rows.values()))
                self.assertFalse(f.ups)
                self.assertEqual(op.schema_and_rows(f.db), before)
                receipt = json.loads((f.operator.root / 'rollback_blocked.receipt.json').read_text())
                self.assertFalse(receipt['rollbackGate']['schemaValid'])
                self.assertFalse(receipt['rollbackGate']['rollbackEligible'])

    def test_barrier_created_while_stopping_worker_is_in_fresh_backup(self):
        f = self.applied_fixture()
        def late_enrollment(service):
            if service == 'provisioning_worker':
                f.connection.execute("INSERT INTO ava_self_registrations VALUES(1,'enrolling')")
                f.connection.commit()
        f.on_stop = late_enrollment
        with self.quiet(), self.assertRaisesRegex(RuntimeError, '^ROLLBACK_IDENTITY_RECONCILIATION_REQUIRED$'):
            f.operator.rollback()
        backups = list(f.operator.root.glob('rollback-backup-*/crm_v2.db'))
        self.assertEqual(len(backups), 1)
        with contextlib.closing(sqlite3.connect(backups[0])) as db:
            self.assertEqual(db.execute('SELECT state FROM ava_self_registrations').fetchall(), [('enrolling',)])
        self.assertEqual(f.stops, list(op.SERVICES))
        self.assertFalse(f.ups)

    def test_quiesce_skips_stopped_or_missing_services(self):
        for missing in (False, True):
            with self.subTest(missing=missing):
                f = self.applied_fixture()
                if missing:
                    del f.rows['provisioning_worker']
                else:
                    f.rows['provisioning_worker']['State']['Running'] = False
                with self.quiet(), mock.patch.object(op.time, 'sleep'):
                    f.operator.rollback()
                self.assertEqual(f.stops, [op.CRM])
                self.assertEqual(set(f.rows), set(op.SERVICES))
                self.assertTrue(all(row['State']['Running'] for row in f.rows.values()))

    def test_quiesce_detects_worker_restart_before_backup(self):
        f = self.applied_fixture()
        def restart_worker(service):
            if service == 'provisioning_worker':
                f.rows[service]['State']['Running'] = True
        f.on_stop = restart_worker
        with self.assertRaisesRegex(RuntimeError, '^ROLLBACK_QUIESCE_FAILED$'):
            f.operator.rollback()
        self.assertFalse(list(f.operator.root.glob('rollback-backup-*')))
        self.assertFalse(f.ups)

    def test_automatic_apply_failure_preserves_semantic_rollback_block_code(self):
        f = self.fixture()
        with self.quiet():
            f.operator.prepare()
        f.fail_up_once = op.CRM
        def late_lease(service):
            if service == 'provisioning_worker':
                f.connection.execute("INSERT INTO ava_invitations VALUES(1,'self-registration:fixture',10,'lease')")
                f.connection.commit()
        f.on_stop = late_lease
        with self.quiet(), mock.patch.object(op.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, '^ROLLBACK_IDENTITY_RECONCILIATION_REQUIRED$'):
                f.operator.apply()
        self.assertEqual([row[0] for row in f.ups], ['provisioning_worker', op.CRM])
        self.assertFalse(any(row['State']['Running'] for row in f.rows.values()))
        receipt = json.loads((f.operator.root / 'rollback_blocked.receipt.json').read_text())
        self.assertTrue(receipt['automatic'])

    def test_live_source_drift_blocks_before_build_or_up(self):
        f = self.fixture()
        f.images[f.rows[op.CRM]['Image']]['hashes']['server.js'] = hashed('production hotfix')
        with self.assertRaisesRegex(RuntimeError, 'OVERLAY_BASE_SOURCE_DRIFT'):
            f.operator.prepare()
        self.assertFalse(any(cmd[1] in ('tag', 'build') or (cmd[1] == 'compose' and 'up' in cmd) for cmd in f.commands))
        self.assertFalse(f.ups)

    def test_candidate_parent_layers_must_preserve_exact_production_filesystem(self):
        f = self.fixture()
        run = f.run
        def changed_parent(args, **kwargs):
            result = run(args, **kwargs)
            if args[1] == 'build':
                image = f.image(args[args.index('-t') + 1])
                image['RootFS']['Layers'][0] = 'unreviewed-os-or-native-layer'
            return result
        f.operator.run = changed_parent
        with self.assertRaisesRegex(RuntimeError, 'PINNED_PARENT_LAYERS_CHANGED'):
            f.operator.prepare()
        self.assertFalse(f.ups)

    def test_apply_failure_after_container_removal_recovers_both_images(self):
        for removed in op.SERVICES:
            with self.subTest(removed=removed):
                f = self.fixture()
                with self.quiet(), mock.patch.object(op.time, 'sleep'):
                    f.operator.prepare()
                    f.fail_up_once = removed
                    f.remove_before_fail = True
                    with self.assertRaisesRegex(RuntimeError, 'APPLY_FAILED_ROLLED_BACK_DATABASE_RETAINED'):
                        f.operator.apply()
                self.assertEqual(set(f.rows), set(op.SERVICES))
                self.assertEqual([row[0] for row in f.ups][-2:], list(op.SERVICES))
                for service in op.SERVICES:
                    self.assertEqual(f.rows[service]['Image'], f.manifest['services'][service]['baseImageId'])
                self.assertIn('release_accounts', op.schema_and_rows(f.db)['tables'])

    def test_worker_compose_drift_blocks_apply_before_migration(self):
        f = self.fixture()
        with self.quiet():
            f.operator.prepare()
        labels = f.rows['provisioning_worker']['Config']['Labels']
        pathlib.Path(labels['com.docker.compose.project.environment_file'].split(',')[0]).write_text('changed env')
        with self.assertRaisesRegex(RuntimeError, 'COMPOSE_INPUT_DRIFT'):
            f.operator.apply()
        self.assertNotIn('release_accounts', op.schema_and_rows(f.db)['tables'])
        self.assertFalse(f.ups)

    def test_other_container_drift_blocks_apply(self):
        f = self.fixture()
        with self.quiet():
            f.operator.prepare()
        f.other[0]['State']['StartedAt'] = 'restarted elsewhere'
        with self.assertRaisesRegex(RuntimeError, 'OTHER_CONTAINER_CHANGED'):
            f.operator.apply()
        self.assertFalse(f.ups)

    def test_sanitized_receipts_never_include_environment_paths_or_credentials(self):
        f = self.fixture()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            f.operator.prepare()
        receipt = (f.operator.root / 'prepared.receipt.json').read_text()
        for secret in ('fixture-secret', 'RUNTIME_ONLY_SECRET', str(f.data), str(f.bundle), 'Env', 'Labels'):
            self.assertNotIn(secret, receipt)
            self.assertNotIn(secret, stdout.getvalue())
        for path in f.operator.root.glob('*.json'):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
