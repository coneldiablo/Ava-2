import importlib.util, json, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
SPEC=importlib.util.spec_from_file_location('voice_knowledge_operator',Path(__file__).with_name('customer-completion-voice-knowledge-release.py'))
m=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)

class VoiceKnowledgeReleaseTests(unittest.TestCase):
    def test_epoch_mtime_frontend_context_retains_exact_bytes_with_fresh_file_mtimes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source';source.mkdir();index=source/'index.html'
            index.write_bytes(b'n'*507);m.os.utime(index,ns=(0,0))
            self.assertEqual(index.stat().st_mtime_ns,0)
            target=root/'context';m.copy_frontend_context(source,target)
            self.assertEqual((target/'index.html').read_bytes(),index.read_bytes())
            self.assertEqual(m.c.tree(target),m.c.tree(source))
            self.assertGreater((target/'index.html').stat().st_mtime_ns,0)
            self.assertEqual(index.stat().st_mtime_ns,0)
    def gate(self,diff,changed=None):
        def git(repo,*args):return diff if args[0]=='diff' else b''
        def blob(repo,ref,name):return b'changed' if ref=='candidate' and name==changed else b'baseline'
        with patch.object(m.c,'git',side_effect=git),patch.object(m.c,'blob',side_effect=blob):
            m.frontend_only(Path('/unused'),'candidate')
    def test_cyrillic_docs_and_frontend_allowed_but_backend_rejected(self):
        self.gate('M\0docs/Кнопки.md\0M\0whatsapp_crm/frontend/src/Simulator.tsx\0'.encode())
        for name in ['src/engine.py','whatsapp_crm/src/services/gemini-text.service.js',
                     'whatsapp_crm/src/services/identity/customer-permissions.js','admin_ui/backend/api/calls.py',
                     'whatsapp_crm/src/services/knowledge-preview-ai.service.js','whatsapp_crm/src/services/gemini-onyx.service.js',
                     'whatsapp_crm/src/routes/customer-knowledge-preview.routes.js']:
            with self.subTest(name=name),self.assertRaisesRegex(RuntimeError,'OUTSIDE_VOICE_KNOWLEDGE_SCOPE'):
                self.gate(('M\0'+name+'\0').encode())
    def test_exact_five_runtime_paths_and_statuses_only(self):
        self.assertEqual(m.EXTRAS,{'src/services/rag.service.js':'M',
            'src/services/integrations/amocrm.js':'M','src/services/integrations/amocrm-catalog.js':'A',
            'src/routes/customer-external-integrations.routes.js':'M','src/services/identity/customer-role-boundary.js':'M'})
        for name,expected in m.EXTRA_REPO.items():
            self.gate((expected+'\0'+name+'\0').encode())
            for status in {'A','M','D'}-{expected}:
                with self.subTest(name=name,status=status),self.assertRaisesRegex(RuntimeError,'EXACT_RUNTIME_STATUS_REQUIRED'):
                    self.gate((status+'\0'+name+'\0').encode())
    def test_frontend_dependency_change_requires_separate_release(self):
        with self.assertRaisesRegex(RuntimeError,'BACKEND_DEPENDENCIES_CHANGED'):
            self.gate(b'M\0whatsapp_crm/frontend/package-lock.json\0','whatsapp_crm/frontend/package-lock.json')
    def test_every_production_image_is_current_e588_not_previous_group(self):
        self.assertEqual(m.BASE,'e588f3b9aa0549fdd7f050ba30b4d01a10dd36ee')
        self.assertEqual(m.IMAGES['crm'],'sha256:adc34e109a4a7b319410289a286daa31cd3cf9a41dd1aa15d35820b3d63fa00f')
        self.assertEqual(set(m.IMAGES),{'crm','worker','engine','admin'})
    def test_up_commands_only_crm_with_no_dependencies(self):
        r=object.__new__(m.Release);r.input_guard=Mock();r.inspect=Mock(return_value={'RestartCount':0,'State':{'Health':{'Status':'healthy'}}});r.check=Mock();r.run=Mock()
        p={'before':{'crm':{}},'image':'candidate','baselineRender':{'environment':{'UNCHANGED':'yes'}},'overrides':{'candidate':'new','rollback':'old'}}
        with patch.object(m.core,'rendered',return_value={**p['baselineRender'],'image':'candidate'}),patch.object(m.core,'compose',return_value=(['docker','compose'],Path('/tmp'),'crm')):
            r.up(p)
        self.assertEqual(r.run.call_args.args[0],['docker','compose','up','-d','--no-deps','--pull','never','--force-recreate','crm'])
    def test_failed_activation_always_attempts_only_code_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            r=object.__new__(m.Release);r.root=Path(directory);r.load=Mock(return_value={'candidateCommit':'candidate'});r.offline_gate_guard=Mock();r.guard_before=Mock();r.backup=Mock(return_value={'path':'fresh-clone'});r.up=Mock(side_effect=RuntimeError('UNHEALTHY'));r.rollback=Mock()
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
    def test_source_fence_changes_exact_five_files_and_ui_preserving_native_preview_gemini_and_all_other_bytes(self):
        base={'src/app.js':'backend','src/services/identity/customer-role-boundary.js':'deployed-policy',
            'frontend/dist/index.html':'same-ui','node_modules/lib.js':'dependency',
            'src/services/knowledge-preview-ai.service.js':'native-preview',
            'src/services/gemini-onyx.service.js':'deployed-gemini',
            **{name:'old-'+name for name,status in m.EXTRAS.items() if status=='M'}}
        files={'frontend/dist/index.html':'new-ui',
            **{name:'new-'+name for name in m.EXTRAS}}
        self.assertEqual(m.c.expected_tree(base,files,True),{'src/app.js':'backend',
            'src/services/identity/customer-role-boundary.js':'deployed-policy','node_modules/lib.js':'dependency',
            'src/services/knowledge-preview-ai.service.js':'native-preview','src/services/gemini-onyx.service.js':'deployed-gemini',**files})
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
    def test_actual_contract_is_exact_base_plus_three_amo_tables_and_one_initializer(self):
        repo=Path(__file__).parents[1]
        self.assertEqual(m.c.sha(m.c.blob(repo,m.BASE,'whatsapp_crm/src/services/rag.service.js')),
            'd05ba2a1ed1c254370c1bbe78eb7b2511af0b5bf91c73e33fa12d378fa4c9119')
        for name,status in m.EXTRAS.items():
            self.assertEqual(m.c.blob(repo,m.BASE,'whatsapp_crm/'+name,optional=True) is None,status=='A')
        baseline=json.loads(m.c.blob(repo,m.BASE,'scripts/customer-completion-release/schema-contract.json'))
        contract=json.loads((repo/'scripts/customer-completion-amo-schema-contract.json').read_text())
        m.validate_amo_contract(contract,baseline)
        changed=json.loads(json.dumps(contract));changed['newTables'].append('unexpected')
        with self.assertRaisesRegex(RuntimeError,'TABLE_SCOPE'):m.validate_amo_contract(changed,baseline)
        changed=json.loads(json.dumps(contract));changed['columns']['instances'].append({'name':'surprise'})
        with self.assertRaisesRegex(RuntimeError,'EXISTING_SCHEMA'):m.validate_amo_contract(changed,baseline)
    def offline_fixture(self,directory):
        root=Path(directory);r=object.__new__(m.Release);r.root=root;r.bundle=root/'bundle';r.manifest_sha='a'*64
        tooling=r.bundle/'tooling';tooling.mkdir(parents=True)
        for name in m.OFFLINE_SOURCES:(tooling/name).write_text('{}')
        r.m={'tooling':{'tooling/'+name:m.c.file_sha(tooling/name) for name in m.OFFLINE_SOURCES}}
        before=root/'before.db';before.write_bytes(b'synthetic-database')
        r.bundle_guard=Mock();r.db_guard=Mock();r.backup=Mock(return_value={'path':str(before),'sha256':'b'*64})
        migrated={'ok':True,'mode':'migrate','existingRowsPreserved':True,'existingColumnsPreserved':True,
            'afterSnapshot':{'tables':{name:{} for name in m.AMO_TABLES}}}
        startup={'ok':True,'realAppStart':True,'customerRowsPreserved':True,'schemaPreserved':True}
        r.run=Mock(side_effect=[json.dumps(migrated),json.dumps(startup)])
        p={'before':{'crm':{'Config':{'Env':['SYNTHETIC_ENV=value']}}},'image':'candidate-image','databaseMetadata':{'owner':[1000,986,0o600]}}
        return r,p
    def test_offline_gate_runs_real_entrypoint_on_owner_clone_with_only_clone_and_readonly_tooling_mounts(self):
        with tempfile.TemporaryDirectory() as directory:
            r,p=self.offline_fixture(directory)
            with patch.object(m.os,'chown'):gate=r.offline_gate(p)
            self.assertTrue(gate['pass']);self.assertFalse(gate['liveDatabaseMounted']);self.assertFalse(gate['liveDdlExecuted'])
            commands=[call.args[0] for call in r.run.call_args_list]
            self.assertEqual(commands[0][-2:],['/release/migrations.cjs','migrate'])
            self.assertEqual(commands[1][-1],'/release/startup-probe.cjs')
            for command in commands:
                self.assertEqual(command[command.index('--network')+1],'none');self.assertIn('--read-only',command)
                self.assertEqual(command[command.index('--user')+1],'1000:986')
                mounts=[command[i+1] for i,value in enumerate(command) if value=='--mount']
                self.assertEqual(len(mounts),2);self.assertTrue(mounts[0].endswith('offline-clone,dst=/verify'))
                self.assertTrue(mounts[1].endswith('offline-runtime,dst=/release,readonly'))
                self.assertIn('DB_PATH=/verify/crm.db',command)
            self.assertEqual((r.root/'crm-offline.private.env').stat().st_mode&0o777,0o600)
            self.assertEqual((r.root/'offline-runtime/startup-probe.cjs').stat().st_mode&0o777,0o444)
            r.offline_gate_guard(p)
    def test_apply_refuses_before_backup_or_activation_without_verified_offline_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            r=object.__new__(m.Release);r.root=Path(directory);r.load=Mock(return_value={});r.backup=Mock();r.up=Mock()
            with self.assertRaisesRegex(RuntimeError,'OFFLINE_GATE_REQUIRED'):r.apply()
            r.backup.assert_not_called();r.up.assert_not_called()
    def test_offline_gate_receipt_hash_and_candidate_image_are_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            r,p=self.offline_fixture(directory)
            with patch.object(m.os,'chown'):r.offline_gate(p)
            p['image']='different-image'
            with self.assertRaisesRegex(RuntimeError,'OFFLINE_GATE_SCOPE_CHANGED'):r.offline_gate_guard(p)
            p['image']='candidate-image';path=r.root/'offline-gate.private.json';path.write_text('{}')
            with self.assertRaisesRegex(RuntimeError,'OFFLINE_GATE_REQUIRED'):r.offline_gate_guard(p)

if __name__=='__main__':unittest.main()
