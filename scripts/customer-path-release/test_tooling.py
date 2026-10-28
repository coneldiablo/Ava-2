"""Local safety tests. Never invokes Docker, SSH or a provider."""
import sys
sys.dont_write_bytecode = True
import base64
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace
import os
import socket

import build_bundle
from common import BASE, IMAGES, NAMES, expected_tree, relative, sha, tree, validate_manifest, validate_receipt
from release_operator import Operator


def package_archive(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        for name, data, kind in entries:
            item = tarfile.TarInfo(name)
            item.type = kind
            if kind == tarfile.REGTYPE:
                item.size = len(data)
                archive.addfile(item, io.BytesIO(data))
            else:
                item.linkname = '../escape'
                archive.addfile(item)
    value = output.getvalue()
    return value, 'sha512-' + base64.b64encode(hashlib.sha512(value).digest()).decode()


class PackagingTests(unittest.TestCase):
    def test_literal_cyrillic_document_does_not_break_runtime_source_diff(self):
        paths = ['docs/customer-path-20261017/ЗАДАЧИ.md',
                 'whatsapp_crm/src/services/ai.service.js', *sorted(build_bundle.ENGINE), *sorted(build_bundle.ADMIN)]
        raw = b''.join(b'M\0' + name.encode('utf-8') + b'\0' for name in paths)
        with patch.object(build_bundle, 'git', return_value=raw) as mocked_git, \
             patch.object(build_bundle, 'blob', side_effect=lambda repo, candidate, name: name.encode('utf-8')):
            selected = build_bundle.source_changes(Path('/unused'), 'a' * 40)
        self.assertIn('-z', mocked_git.call_args.args)
        self.assertEqual(selected['crm']['src/services/ai.service.js'][0], 'whatsapp_crm/src/services/ai.service.js')
        self.assertEqual(selected['worker']['src/services/ai.service.js'][1], b'whatsapp_crm/src/services/ai.service.js')
        self.assertEqual(set(selected['engine']), build_bundle.ENGINE)
        self.assertEqual(len(selected['admin']), 3)
        self.assertTrue(all('ЗАДАЧИ' not in name for service in selected.values() for name in service))

    def test_exact_frontend_removes_only_old_frontend(self):
        before = {'frontend/dist/old.js': 'old', 'frontend/dist/index.html': 'before',
                  'src/a.js': 'retained', 'node_modules/x.js': 'retained-dep', '__shared_runtime__/src/a.py': 'shared'}
        changes = {'frontend/dist/index.html': 'new', 'frontend/dist/new.js': 'asset', 'src/b.js': 'new-source'}
        result = expected_tree(before, changes, True)
        self.assertNotIn('frontend/dist/old.js', result)
        self.assertEqual(result['src/a.js'], 'retained')
        self.assertEqual(result['node_modules/x.js'], 'retained-dep')
        self.assertEqual(result['__shared_runtime__/src/a.py'], 'shared')
        self.assertEqual(len(result), 6)

    def test_worker_never_implicitly_deletes_frontend(self):
        self.assertEqual(expected_tree({'frontend/dist/x': 'x'}, {}, False), {'frontend/dist/x': 'x'})

    def test_safe_path_rejects_traversal_appledouble_and_shell_control(self):
        for value in ('../x', '/x', 'x//y', 'x/./y', 'x/._y', 'x\\y', 'x\ny', 'x\0y'):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                relative(value)

    def test_frontend_receipt_requires_exact_commit_and_files(self):
        files = {'index.html': 'a', 'assets/main.js': 'b'}
        validate_receipt({'sourceCommit': 'a' * 40, 'files': files}, 'a' * 40, files)
        for receipt in ({'sourceCommit': 'b' * 40, 'files': files}, {'sourceCommit': 'a' * 40, 'files': {'index.html': 'a'}}):
            with self.assertRaises(RuntimeError):
                validate_receipt(receipt, 'a' * 40, files)

    def test_payload_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'target').write_text('data'); (root / 'link').symlink_to('target')
            with self.assertRaisesRegex(RuntimeError, 'TREE_SYMLINK_FORBIDDEN'):
                tree(root)

    def test_verified_registry_tar_is_extracted_without_scripts(self):
        metadata = json.dumps({'name': 'safe', 'version': '1', 'scripts': {'install': 'never executed'}}).encode()
        data, integrity = package_archive([('package/package.json', metadata, tarfile.REGTYPE),
                                            ('package/index.js', b'module.exports=1;', tarfile.REGTYPE)])
        result = build_bundle.extract_package(data, integrity, 'safe', '1')
        self.assertEqual(result['index.js'], b'module.exports=1;')

    def test_dependency_bad_integrity_is_rejected(self):
        data, _ = package_archive([])
        with self.assertRaisesRegex(RuntimeError, 'DEPENDENCY_INTEGRITY_FAILED'):
            build_bundle.extract_package(data, 'sha512-not-valid', 'safe', '1')

    def test_dependency_tar_links_and_traversal_rejected(self):
        for name, kind in [('package/../escape', tarfile.REGTYPE), ('package/link', tarfile.SYMTYPE),
                           ('package/link', tarfile.LNKTYPE), ('other/package.json', tarfile.REGTYPE)]:
            data, integrity = package_archive([(name, b'bad', kind)])
            with self.subTest(name=name, kind=kind), self.assertRaises(RuntimeError):
                build_bundle.extract_package(data, integrity, 'safe', '1')

    def test_duplicate_tar_member_rejected(self):
        data, integrity = package_archive([('package/package.json', b'{}', tarfile.REGTYPE)] * 2)
        with self.assertRaisesRegex(RuntimeError, 'DEPENDENCY_ARCHIVE_DUPLICATE'):
            build_bundle.extract_package(data, integrity, 'safe', '1')

    def test_dependency_wrong_name_version_rejected(self):
        data, integrity = package_archive([('package/package.json', b'{"name":"different","version":"1"}', tarfile.REGTYPE)])
        with self.assertRaisesRegex(RuntimeError, 'DEPENDENCY_METADATA_MISMATCH'):
            build_bundle.extract_package(data, integrity, 'safe', '1')

    def test_manifest_excludes_production_package_overwrites(self):
        m = {'kind': 'customer-path-20261017', 'baseCommit': BASE, 'candidateCommit': 'a' * 40, 'services': {}}
        for role in NAMES:
            m['services'][role] = {'baseImage': IMAGES[role], 'candidateTag': 'ava-customer-path-' + role + ':a-b',
                'files': {'src/valid.js': 'a' * 64}, 'baseFiles': {'src/valid.js': 'b' * 64}}
        validate_manifest(m)
        for name in ('package.json', 'package-lock.json', 'node_modules/existing.js'):
            with self.subTest(name=name):
                m['services']['crm']['files'] = {name: 'a' * 64}
                m['services']['crm']['baseFiles'] = {name: 'b' * 64}
                with self.assertRaisesRegex(RuntimeError, 'PRODUCTION_DEPENDENCY_OVERWRITE_FORBIDDEN'):
                    validate_manifest(m)


class ReleaseSafetyTests(unittest.TestCase):
    def test_exact_worker_agent_socket_uses_metadata_and_rejects_other_sockets(self):
        with tempfile.TemporaryDirectory(prefix='ava-bind-',dir='/tmp') as directory:
            source=Path(directory);sock=socket.socket(socket.AF_UNIX)
            try:
                sock.bind(str(source/'agent.sock'))
                operator=object.__new__(Operator)
                mount={'Type':'bind','Source':str(source),'Destination':'/run/ava-telephony','RW':False}
                rows={'worker':{'Mounts':[mount]}}
                with patch('release_operator.IPC_BIND_SOURCE',source):
                    first=operator.binding_hashes(rows)
                    item=first[str(source/'agent.sock')]
                    self.assertEqual(item['kind'],'unix-socket');self.assertEqual(item['inode'],(source/'agent.sock').lstat().st_ino)
                    os.chmod(source/'agent.sock',0o600)
                    self.assertNotEqual(first,operator.binding_hashes(rows))
                    mount['Destination']='/run/unapproved'
                    with self.assertRaisesRegex(RuntimeError,'CONFIG_BIND_SPECIAL_FILE'):operator.binding_hashes(rows)
            finally:sock.close()

    def test_exact_admin_os_release_symlink_tracks_target_content_and_rejects_other_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'lib').mkdir();target=root/'lib/os-release';target.write_text('NAME=Synthetic\n')
            source=root/'os-release';source.symlink_to('lib/os-release')
            operator=object.__new__(Operator)
            mount={'Type':'bind','Source':str(source),'Destination':'/host/etc/os-release','RW':False}
            rows={'admin':{'Mounts':[mount]}}
            with patch('release_operator.OS_RELEASE_SOURCE',source):
                first=operator.binding_hashes(rows);item=first[str(source)]
                self.assertEqual(item['kind'],'os-release-symlink');self.assertEqual(item['target'],'lib/os-release')
                self.assertEqual(item['contentSha256'],sha(b'NAME=Synthetic\n'))
                target.write_text('NAME=Changed\n');self.assertNotEqual(first,operator.binding_hashes(rows))
                mount['Destination']='/host/etc/unapproved'
                with self.assertRaisesRegex(RuntimeError,'CONFIG_BIND_SPECIAL_FILE'):operator.binding_hashes(rows)

    def test_engine_ledger_snapshot_roundtrip_and_typed_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'calls.db'
            db = sqlite3.connect(path); db.executescript("CREATE TABLE calls(id INTEGER PRIMARY KEY,status TEXT,raw BLOB);INSERT INTO calls VALUES(1,'unknown',X'0001');"); db.close()
            operator = object.__new__(Operator)
            original = operator.engine_snapshot(str(path))
            self.assertEqual(operator.engine_snapshot(str(path)), json.loads(json.dumps(original)))
            db = sqlite3.connect(path); db.execute("UPDATE calls SET status='queued'"); db.commit(); db.close()
            self.assertNotEqual(operator.engine_snapshot(str(path)), original)

    def rollback_fixture(self, directory):
        operator = object.__new__(Operator); operator.root = Path(directory)
        (operator.root / 'live-migration-started.private.json').write_text('{}')
        p = {'candidateCommit': 'a' * 40, 'database': str(operator.root / 'db'), 'afterMigrationSnapshot': {'old': 'same'},
             'engineBeforeApply': {'calls.db': {'digest': 'calls'}}, 'before': {}, 'images': {}, 'intended': {}}
        rows = {}
        for role in NAMES:
            before = {'Image': 'old-' + role, 'Config': {'Env': ['SAFE=before']}}
            p['before'][role] = before; p['images'][role] = 'candidate-' + role
            p['intended'][role] = {'environment': {'SAFE': 'candidate'}}
            rows[role] = {'Image': p['images'][role], 'Config': {'Env': ['SAFE=candidate']}}
        operator.load = Mock(return_value=p); operator.idle = Mock(); operator.input_guard = Mock()
        operator.rows = Mock(return_value=rows); operator.stop = Mock(); operator.up = Mock()
        operator.recover_services = Mock(return_value={'allRunning': True})
        operator.engine_snapshot = Mock(return_value={'digest': 'calls'}); operator.verify = Mock(return_value={'ok': True})
        return operator, p

    def test_old_code_rollback_refused_after_new_customer_data(self):
        with tempfile.TemporaryDirectory() as directory:
            operator, _ = self.rollback_fixture(directory)
            operator.migration = Mock(return_value={'snapshot': {'old': 'new-data'}})
            with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_NEW_CUSTOMER_DATA'):
                operator.rollback()
            operator.recover_services.assert_called_with(operator.load.return_value, compatible=True)
            operator.up.assert_not_called()

    def test_unknown_external_send_fence_refuses_old_code(self):
        with tempfile.TemporaryDirectory() as directory:
            operator, _ = self.rollback_fixture(directory)
            operator.migration = Mock(side_effect=[{'snapshot': {'old': 'same'}}, {'barriers': {'unknownDocument': True}}])
            with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_EXTERNAL_OUTCOME_OR_REGISTRATION_FENCE'):
                operator.rollback()
            operator.recover_services.assert_called_with(operator.load.return_value, compatible=True)

    def test_new_call_ledger_data_refuses_old_code(self):
        with tempfile.TemporaryDirectory() as directory:
            operator, _ = self.rollback_fixture(directory)
            operator.migration = Mock(side_effect=[{'snapshot': {'old': 'same'}}, {'barriers': {'unknownDocument': False}}])
            operator.engine_snapshot = Mock(return_value={'digest': 'new-call'})
            with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_NEW_CALL_DATA'):
                operator.rollback()
            operator.recover_services.assert_called_with(operator.load.return_value, compatible=True)

    def test_safe_rollback_keeps_database_and_changes_only_code(self):
        with tempfile.TemporaryDirectory() as directory:
            operator, _ = self.rollback_fixture(directory)
            operator.migration = Mock(side_effect=[{'snapshot': {'old': 'same'}}, {'barriers': {'unknownDocument': False}}])
            result = operator.rollback()
            self.assertTrue(result['databaseRetained'])
            operator.recover_services.assert_called_with(operator.load.return_value, compatible=False)

    def test_runtime_env_drift_is_rejected_before_quiesce(self):
        with tempfile.TemporaryDirectory() as directory:
            operator, _ = self.rollback_fixture(directory)
            operator.rows.return_value['crm']['Config']['Env'] = ['SAFE=changed-by-someone']
            with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_RUNTIME_ENV_DRIFT'):
                operator.rollback()
            operator.stop.assert_not_called(); operator.up.assert_not_called()

    def test_initial_apply_stop_failure_recovers_original_services(self):
        with tempfile.TemporaryDirectory() as directory:
            operator, p = self.rollback_fixture(directory)
            (operator.root / 'live-migration-started.private.json').unlink()
            operator.guard_before = Mock(); operator.stop = Mock(side_effect=RuntimeError('PARTIAL_STOP'))
            operator.rollback = Mock(side_effect=RuntimeError('ACTIVE_NEW_CALL'))
            with self.assertRaisesRegex(RuntimeError, 'APPLY_FAILED_COMPATIBLE_RECOVERY_REQUIRED'):
                operator.apply()
            operator.recover_services.assert_called_once_with(p, compatible=False)

    def test_partial_rollback_stop_failure_recovers_compatible_services(self):
        with tempfile.TemporaryDirectory() as directory:
            operator, p = self.rollback_fixture(directory)
            operator.stop = Mock(side_effect=RuntimeError('PARTIAL_STOP'))
            with self.assertRaisesRegex(RuntimeError, 'PARTIAL_STOP'):
                operator.rollback()
            operator.recover_services.assert_called_once_with(p, compatible=True)

    def recovery_fixture(self, directory, running_engine=False):
        operator, p = self.rollback_fixture(directory)
        del operator.recover_services
        states = {role: {'Id': role, 'Image': p['images'][role], 'State': {'Running': running_engine and role == 'engine'}} for role in NAMES}
        operator.inspect = Mock(side_effect=lambda name: states[next(r for r,n in NAMES.items() if n==name)])
        operator.ready = Mock()
        def run(command, **kwargs):
            role = command[-1]
            if role == 'admin':
                raise RuntimeError('ADMIN_FAILS')
            states[role]['State']['Running'] = True
            return ''
        operator.run = Mock(side_effect=run)
        return operator, p, states

    def test_first_service_restart_failure_never_skips_other_three(self):
        with tempfile.TemporaryDirectory() as directory:
            operator, p, states = self.recovery_fixture(directory)
            result = operator.recover_services(p, compatible=True)
            self.assertEqual([c.args[0][-1] for c in operator.run.call_args_list], ['admin','engine','worker','crm'])
            self.assertTrue(all(states[x]['State']['Running'] for x in ['engine','worker','crm']))
            self.assertFalse(result['allRunning'])

    def test_recovery_does_not_restart_already_running_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            operator, p, _ = self.recovery_fixture(directory, running_engine=True)
            operator.recover_services(p, compatible=True)
            self.assertNotIn('engine', [c.args[0][-1] for c in operator.run.call_args_list])

    def test_migration_uses_database_owner_uid_and_readable_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); database = root / 'db'; database.touch()
            tooling = root / 'bundle/tooling'; tooling.mkdir(parents=True)
            for name in ['migrations.cjs','schema-contract.json']:
                (tooling / name).write_text('{}')
            operator = object.__new__(Operator); operator.root = root; operator.bundle = root / 'bundle'
            operator.m = {'tooling': {name: sha(b'{}') for name in ['migrations.cjs','schema-contract.json']}}
            operator.run = Mock(return_value='{"ok":true,"mode":"migrate"}')
            original_stat = Path.stat
            def stat(path, **kwargs):
                if path == database:
                    return SimpleNamespace(st_uid=1000,st_gid=986)
                return original_stat(path, **kwargs)
            with patch.object(Path, 'stat', stat):
                operator.migration('image', database)
            command = operator.run.call_args.args[0]
            self.assertEqual(command[command.index('--user')+1], '1000:986')
            self.assertEqual((root/'migration-runtime/migrations.cjs').stat().st_mode&0o777, 0o444)

    def metadata_fixture(self, directory):
        root = Path(directory); database = root / 'db'; database.write_bytes(b'original')
        database.chmod(0o600); stat = database.stat(); parent = root.stat()
        operator = object.__new__(Operator)
        p = {'database':str(database),'databaseIdentity':[stat.st_dev,stat.st_ino],
             'databaseMetadata':[stat.st_uid,stat.st_gid,stat.st_mode&0o777],
             'databaseDirectoryMetadata':[parent.st_uid,parent.st_gid,parent.st_mode&0o777]}
        return operator,p,database

    def test_database_inode_replacement_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            operator,p,database = self.metadata_fixture(directory)
            replacement = Path(directory)/'new'; replacement.write_bytes(b'new'); replacement.chmod(0o600)
            os.replace(replacement,database)
            with self.assertRaisesRegex(RuntimeError,'DATABASE_IDENTITY_OR_METADATA_CHANGED'):
                operator.database_metadata_guard(p)

    def test_inaccessible_sidecar_mode_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            operator,p,database = self.metadata_fixture(directory)
            wal=Path(str(database)+'-wal');wal.touch();wal.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError,'DATABASE_SIDECAR_OWNER_OR_MODE_CHANGED'):
                operator.database_metadata_guard(p)

    def test_worker_writer_probe_uses_exact_uid_and_rollback_without_dml(self):
        with tempfile.TemporaryDirectory() as directory:
            operator=object.__new__(Operator);operator.run=Mock(return_value='{"writerAccess":true}')
            operator.writer_access('candidate',Path(directory)/'db','1000:986')
            command=operator.run.call_args.args[0]
            self.assertEqual(command[command.index('--user')+1],'1000:986')
            self.assertIn('BEGIN IMMEDIATE;ROLLBACK;',command[-1])
            self.assertNotIn('INSERT INTO',command[-1]);self.assertNotIn('UPDATE ',command[-1])


if __name__ == '__main__':
    unittest.main()
