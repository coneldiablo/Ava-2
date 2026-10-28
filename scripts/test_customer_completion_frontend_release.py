import importlib.util, json, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
SPEC=importlib.util.spec_from_file_location('frontend_operator',Path(__file__).with_name('customer-completion-frontend-release.py'))
m=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)

class FrontendReleaseTests(unittest.TestCase):
    def gate(self,diff,changed=None):
        def git(repo,*args):return diff if args[0]=='diff' else b''
        def blob(repo,ref,name):return b'changed' if ref=='candidate' and name==changed else b'baseline'
        with patch.object(m.c,'git',side_effect=git),patch.object(m.c,'blob',side_effect=blob):
            m.frontend_only(Path('/unused'),'candidate')
    def test_cyrillic_docs_and_frontend_allowed_but_backend_rejected(self):
        self.gate('M\0docs/Кнопки.md\0M\0whatsapp_crm/frontend/src/Simulator.tsx\0'.encode())
        for name in ['src/engine.py','whatsapp_crm/src/services/gemini-text.service.js',
                     'whatsapp_crm/src/services/identity/customer-role-boundary.js','admin_ui/backend/api/calls.py']:
            with self.subTest(name=name),self.assertRaisesRegex(RuntimeError,'NON_FRONTEND_CHANGE'):
                self.gate(('M\0'+name+'\0').encode())
    def test_only_exact_four_backend_files_and_statuses_are_allowed(self):
        self.assertEqual(m.EXTRAS,{'src/services/gemini-onyx.service.js':'M',
            'src/services/knowledge-preview-ai.service.js':'A',
            'src/routes/customer-knowledge-preview.routes.js':'M',
            'src/routes/customer-business-gpt.routes.js':'M'})
        for name,expected in m.EXTRA_REPO.items():
            self.gate((expected+'\0'+name+'\0').encode())
            for status in {'A','M','D'}-{expected}:
                with self.subTest(name=name,status=status),self.assertRaisesRegex(RuntimeError,'EXACT_RUNTIME_STATUS_REQUIRED'):
                    self.gate((status+'\0'+name+'\0').encode())
    def test_frontend_dependency_change_requires_separate_release(self):
        with self.assertRaisesRegex(RuntimeError,'BACKEND_DEPENDENCIES_CHANGED'):
            self.gate(b'M\0whatsapp_crm/frontend/package-lock.json\0','whatsapp_crm/frontend/package-lock.json')
    def test_every_production_image_is_current_da3_not_previous_group(self):
        self.assertEqual(m.BASE,'da3a2b1a1d456cc12a1a1345706b839046dfad01')
        self.assertEqual(m.IMAGES['crm'],'sha256:0cd3db5d4790dfc468792c16337d645c9ecebdd0d6501cb2253fadd0357d5cee')
        self.assertEqual(set(m.IMAGES),{'crm','worker','engine','admin'})
    def test_up_commands_only_crm_with_no_dependencies(self):
        r=object.__new__(m.Release);r.input_guard=Mock();r.inspect=Mock(return_value={'RestartCount':0,'State':{'Health':{'Status':'healthy'}}});r.check=Mock();r.run=Mock()
        p={'before':{'crm':{}},'image':'candidate','baselineRender':{'environment':{'UNCHANGED':'yes'}},'overrides':{'candidate':'new','rollback':'old'}}
        with patch.object(m.core,'rendered',return_value={**p['baselineRender'],'image':'candidate'}),patch.object(m.core,'compose',return_value=(['docker','compose'],Path('/tmp'),'crm')):
            r.up(p)
        self.assertEqual(r.run.call_args.args[0],['docker','compose','up','-d','--no-deps','--pull','never','--force-recreate','crm'])
    def test_failed_activation_always_attempts_only_code_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            r=object.__new__(m.Release);r.root=Path(directory);r.load=Mock(return_value={'candidateCommit':'candidate'});r.guard_before=Mock();r.backup=Mock(return_value={'path':'fresh-clone'});r.up=Mock(side_effect=RuntimeError('UNHEALTHY'));r.rollback=Mock()
            with patch.object(m.core,'idle'),self.assertRaisesRegex(RuntimeError,'PREVIOUS_CRM_RESTORED_DATABASE_RETAINED'):r.apply()
            r.rollback.assert_called_once();self.assertTrue((r.root/'backup.private.json').exists())
            self.assertEqual(json.loads((r.root/'activation-failure.private.json').read_text())['code'],'UNHEALTHY')
    def test_replaced_database_inode_fails_before_activation(self):
        with tempfile.TemporaryDirectory() as directory:
            r=object.__new__(m.Release);file=Path(directory)/'crm.db';file.write_bytes(b'data');file.chmod(0o600)
            p={'database':str(file),'databaseMetadata':r.metadata(file)}
            new=Path(directory)/'replacement';new.write_bytes(b'new');new.chmod(0o600);new.replace(file)
            with self.assertRaisesRegex(RuntimeError,'DATABASE_METADATA_CHANGED'):r.db_guard(p)
    def test_strict_guard_fails_other_container_change_recovery_still_allowed(self):
        r=object.__new__(m.Release);r.bundle_guard=Mock();r.db_guard=Mock();r.inputs=Mock(return_value={});r.others=Mock(return_value={'worker':'changed'})
        p={'inputs':{},'before':{},'otherContainers':{'worker':'previous'}}
        with self.assertRaisesRegex(RuntimeError,'OTHER_CONTAINERS_CHANGED'):r.input_guard(p)
        r.input_guard(p,recovery=True)
    def test_source_fence_changes_exact_four_files_preserving_policy_and_all_other_backend_bytes(self):
        base={'src/app.js':'backend','src/services/identity/customer-role-boundary.js':'deployed-policy',
            'frontend/dist/old.js':'old','node_modules/lib.js':'dependency',
            **{name:'old-'+name for name,status in m.EXTRAS.items() if status=='M'}}
        files={'frontend/dist/index.html':'new','frontend/dist/new.js':'new-js',
            **{name:'new-'+name for name in m.EXTRAS}}
        self.assertEqual(m.c.expected_tree(base,files,True),{'src/app.js':'backend',
            'src/services/identity/customer-role-boundary.js':'deployed-policy','node_modules/lib.js':'dependency',**files})
    def test_bind_permutation_only_is_accepted_without_a_drift_receipt(self):
        before={'Binds':['/data:/app/data:rw','/voice:/app/voice-config:ro'],'Privileged':False}
        after={**before,'Binds':list(reversed(before['Binds']))}
        r=object.__new__(m.Release)
        self.assertEqual(m.normalized_host_config(before),m.normalized_host_config(after))
        r.host_config_guard(before,after)
    def test_changed_bind_source_or_ro_mode_is_rejected_and_private_record_is_0600(self):
        before={'Binds':['/data:/app/data:rw','/voice:/app/voice-config:ro'],'Privileged':False}
        for changed in ['/other:/app/data:rw','/data:/app/data:ro']:
            with self.subTest(changed=changed),tempfile.TemporaryDirectory() as directory:
                r=object.__new__(m.Release);r.root=Path(directory)
                after={**before,'Binds':[changed,before['Binds'][1]]}
                with self.assertRaisesRegex(RuntimeError,'HOST_CONFIG_CHANGED'):r.host_config_guard(before,after)
                file=r.root/'host-config-drift.private.json';record=json.loads(file.read_text())
                self.assertEqual(file.stat().st_mode&0o777,0o600)
                self.assertEqual(record['changedKeys'],['Binds']);self.assertEqual(record['before'],before)
                self.assertEqual(set(m.HOST_CONFIG_DRIFT_RECEIPT),{'changedKeys','beforeSha256','afterSha256'})
    def test_duplicate_or_colliding_bind_and_actual_mount_destinations_are_rejected(self):
        for binds in [['/data:/app/data:rw','/data:/app/data:rw'],['/data:/app/data:rw','/other:/app/data:ro']]:
            with self.assertRaisesRegex(RuntimeError,'COLLISION'):m.normalized_host_config({'Binds':binds})
        with self.assertRaisesRegex(RuntimeError,'COLLISION'):m.unique_mount_destinations([{'Destination':'/app/data'},{'Destination':'/app/data'}])
    def test_any_other_host_config_field_including_new_null_field_is_still_exact(self):
        before={'Binds':['/data:/app/data:rw'],'Privileged':False}
        for extra in [{'Privileged':True},{'CapAdd':['NET_ADMIN']},{'NewField':None}]:
            with self.subTest(extra=extra),tempfile.TemporaryDirectory() as directory:
                r=object.__new__(m.Release);r.root=Path(directory)
                with self.assertRaisesRegex(RuntimeError,'HOST_CONFIG_CHANGED'):r.host_config_guard(before,{**before,**extra})

if __name__=='__main__':unittest.main()
