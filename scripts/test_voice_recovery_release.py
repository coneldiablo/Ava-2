import copy, importlib.util, json, os, tarfile, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

SPEC=importlib.util.spec_from_file_location('voice_recovery_release',Path(__file__).with_name('voice-recovery-release.py'))
m=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)

class RecoveryReleaseTests(unittest.TestCase):
    def git_fixture(self,changes=None,dep=None):
        changes=changes or {**{'whatsapp_crm/'+n:s for n,s in m.CRM.items()},**m.ENGINE,**m.FRONTEND}
        diff=b''.join(s.encode()+b'\0'+n.encode()+b'\0' for n,s in changes.items())
        def git(repo,*args):return diff if args[0]=='diff' else b''
        def blob(repo,ref,name,optional=False):return b'new' if ref=='candidate' and name==dep else b'old'
        return patch.object(m.c,'git',side_effect=git),patch.object(m.c,'blob',side_effect=blob)
    def test_exact_current_baseline_and_all_images(self):
        self.assertEqual(m.BASE,'c5c502c7d15a5fc029b8651b3fe6cad8d65b1c04')
        self.assertEqual(m.IMAGES['crm'],'sha256:13ff8ad52166129f0d85acab04d6796278748c77e08affa200990ad6a7d4da2b')
        self.assertEqual(m.SELECTED,('engine','worker','crm'));self.assertNotIn('admin',m.SELECTED)
        self.assertEqual(m.WORKER,m.CRM)
    def test_exact_source_statuses_and_cyrillic_docs(self):
        changes={**{'whatsapp_crm/'+n:s for n,s in m.CRM.items()},**m.ENGINE,**m.FRONTEND,'docs/Готовность.md':'M'}
        a,b=self.git_fixture(changes)
        with a,b:m.source_scope(Path('/repo'),'candidate')
        changes['whatsapp_crm/src/services/voice-waiting.service.js']='M'
        a,b=self.git_fixture(changes)
        with a,b,self.assertRaisesRegex(RuntimeError,'EXACT_RUNTIME_STATUS'):m.source_scope(Path('/repo'),'candidate')
    def test_non_allowlisted_runtime_and_missing_expected_runtime_fail(self):
        changes={**{'whatsapp_crm/'+n:s for n,s in m.CRM.items()},**m.ENGINE,**m.FRONTEND}
        for name in ('src/providers/neuro_vertex.py','admin_ui/backend/api/calls.py','whatsapp_crm/src/app.js','whatsapp_crm/src/services/rag.service.js',
                     'whatsapp_crm/frontend/src/pages/Dashboard.tsx'):
            a,b=self.git_fixture({**changes,name:'M'})
            with a,b,self.assertRaisesRegex(RuntimeError,'OUTSIDE_VOICE_RECOVERY_SCOPE'):m.source_scope(Path('/repo'),'candidate')
        changes.pop('src/engine.py');a,b=self.git_fixture(changes)
        with a,b,self.assertRaisesRegex(RuntimeError,'EXACT_RUNTIME_CHANGESET'):m.source_scope(Path('/repo'),'candidate')
    def test_dependency_change_is_rejected(self):
        for name in ('requirements.txt','whatsapp_crm/package-lock.json','whatsapp_crm/frontend/package.json'):
            a,b=self.git_fixture(dep=name)
            with a,b,self.assertRaisesRegex(RuntimeError,'DEPENDENCIES_CHANGED'):m.source_scope(Path('/repo'),'candidate')
    def test_frontend_epoch_context_gets_fresh_mtime_and_identical_bytes(self):
        with tempfile.TemporaryDirectory() as d:
            source=Path(d)/'source';source.mkdir();file=source/'index.html';file.write_bytes(b'n'*507);os.utime(file,ns=(0,0))
            target=Path(d)/'context';m.copy_context(source,target)
            self.assertEqual(m.c.tree(source),m.c.tree(target));self.assertEqual(file.stat().st_mtime_ns,0)
            self.assertGreater((target/'index.html').stat().st_mtime_ns,0)
    def test_yandex_secrets_only_added_to_crm_and_rollback_exact_old_env(self):
        rows={k:{'Image':v,'Config':{'Env':['UNCHANGED=yes']}} for k,v in m.IMAGES.items()}
        rows['engine']['Config']['Env']+=['YANDEX_CLOUD_API_KEY=synthetic-secret','YANDEX_CLOUD_FOLDER_ID=synthetic-folder']
        r=object.__new__(m.Release);p={'before':rows,'credentialHashes':dict(zip(m.ENV_ADDITIONS,[m.c.sha(b'synthetic-secret'),m.c.sha(b'synthetic-folder')]))}
        self.assertEqual(r.credentials(rows),dict(zip(m.ENV_ADDITIONS,['synthetic-secret','synthetic-folder'])))
        for role in ('worker','engine','crm'):
            expected=m.core.envmap(rows[role])
            if role=='crm':expected.update(r.credentials(rows))
            self.assertEqual(r.expected_env(p,role),expected)
            self.assertEqual(r.expected_env(p,role,True),m.core.envmap(rows[role]))
        rows['crm']['Config']['Env']+=['YANDEX_CLOUD_API_KEY=unexpected']
        with self.assertRaisesRegex(RuntimeError,'YANDEX_CRM_PREIMAGE_CHANGED'):r.credentials(rows)
    def test_private_credential_hash_binding_rejects_changed_value(self):
        r=object.__new__(m.Release);rows={k:{'Image':v,'Config':{'Env':[]}} for k,v in m.IMAGES.items()}
        rows['engine']['Config']['Env']=['YANDEX_CLOUD_API_KEY=fixture','YANDEX_CLOUD_FOLDER_ID=folder']
        p={'before':rows,'credentialHashes':{k:'0'*64 for k in m.ENV_ADDITIONS}}
        with self.assertRaisesRegex(RuntimeError,'PREPARED_CREDENTIAL_HASH_DRIFT'):r.expected_env(p,'crm')
    def test_missing_empty_or_multiline_credential_fails_closed(self):
        r=object.__new__(m.Release)
        for value in ('','multiline\nsecret'):
            rows={'crm':{'Config':{'Env':[]}},'engine':{'Config':{'Env':['YANDEX_CLOUD_API_KEY='+value,'YANDEX_CLOUD_FOLDER_ID=folder']}}}
            with self.assertRaisesRegex(RuntimeError,'YANDEX_SOURCE_ENV_MISSING'):r.credentials(rows)
    def test_only_host_bind_order_normalized_all_other_fields_exact(self):
        before={'Binds':['/a:/app/data:rw','/b:/app/config:ro'],'Privileged':False}
        self.assertEqual(m.normalized_host_config(before),m.normalized_host_config({**before,'Binds':list(reversed(before['Binds']))}))
        for binds in [['/a:/app/data:rw','/b:/app/data:ro'],['/a:/app/data:rw','/a:/app/data:rw']]:
            with self.assertRaisesRegex(RuntimeError,'COLLISION'):m.normalized_host_config({'Binds':binds})
        with tempfile.TemporaryDirectory() as d:
            r=object.__new__(m.Release);r.root=Path(d)
            with self.assertRaisesRegex(RuntimeError,'HOST_CONFIG_CHANGED:engine'):r.host_guard('engine',before,{**before,'NewField':None})
            self.assertEqual((Path(d)/'engine-host-config-drift.private.json').stat().st_mode&0o777,0o600)
    def test_full_tree_projection_retains_production_only_files(self):
        base={'src/engine.py':'old','__shared_runtime__/src/core/outbound_store.py':'keep','node_modules/x':'dependency','frontend/dist/index.html':'old-ui','assets/audio/office-ambience.wav':'keep-audio'}
        files={'src/engine.py':'new','frontend/dist/index.html':'new-ui'}
        self.assertEqual(m.c.expected_tree(base,files,True),{**base,**files})
    def test_other_container_guard_is_not_disabled_in_normal_path(self):
        r=object.__new__(m.Release);r.bundle_guard=Mock();r.db_guard=Mock();r.inputs=Mock(return_value={});r.others=Mock(return_value={'admin':'changed'})
        p={'inputs':{},'before':{},'otherContainers':{'admin':'original'}}
        with self.assertRaisesRegex(RuntimeError,'OTHER_CONTAINERS_CHANGED'):r.input_guard(p)
        r.input_guard(p,recovery=True)
    def test_database_inode_uid_gid_mode_and_sidecars_fenced(self):
        with tempfile.TemporaryDirectory() as d:
            r=object.__new__(m.Release);file=Path(d)/'crm.db';file.write_bytes(b'fixture');file.chmod(0o600)
            p={'databaseMetadata':{str(file):r.metadata(file)}};r.db_guard(p)
            side=Path(str(file)+'-wal');side.write_bytes(b'fixture');side.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError,'DATABASE_SIDECAR_CHANGED'):r.db_guard(p)
            side.unlink();replacement=Path(d)/'replacement';replacement.write_bytes(b'fixture');replacement.chmod(0o600);replacement.replace(file)
            with self.assertRaisesRegex(RuntimeError,'DATABASE_METADATA_CHANGED'):r.db_guard(p)
    def test_offline_gate_is_mandatory_before_any_backup_or_activation(self):
        with tempfile.TemporaryDirectory() as d:
            r=object.__new__(m.Release);r.root=Path(d);r.load=Mock(return_value={});r.crm_backup=Mock();r.up=Mock()
            with self.assertRaisesRegex(RuntimeError,'OFFLINE_GATE_REQUIRED'):r.apply()
            r.crm_backup.assert_not_called();r.up.assert_not_called()
    def test_partial_recovery_attempts_every_role_even_if_engine_is_busy(self):
        with tempfile.TemporaryDirectory() as d:
            r=object.__new__(m.Release);r.root=Path(d);r.inspect=Mock(side_effect=RuntimeError('MISSING'));r.up=Mock(side_effect=[RuntimeError('ACTIVE_CALLS'),None,None]);r.check=Mock(side_effect=[RuntimeError('IMAGE_STATE_INVALID:engine'),None,None])
            with self.assertRaisesRegex(RuntimeError,'CODE_ROLLBACK_REQUIRES_ATTENTION'):r.recover({})
            self.assertEqual([c.args[1] for c in r.up.call_args_list],list(m.SELECTED))
            receipt=json.loads((r.root/'recovery.private.json').read_text());self.assertEqual(receipt['failures'],{'engine':'ACTIVE_CALLS'});self.assertFalse(receipt['databaseRestored'])
            self.assertFalse(receipt['allPriorImagesRestored']);self.assertEqual(r.check.call_count,3)
            self.assertEqual(receipt['finalReadbackFailures'],{'engine':'IMAGE_STATE_INVALID:engine'})
    def test_startup_connection_refusal_and_503_are_bounded_readiness_retries(self):
        with tempfile.TemporaryDirectory() as d:
            r=object.__new__(m.Release);r.root=Path(d);r.input_guard=Mock();r.run=Mock();r.inspect=Mock(return_value={'RestartCount':0});r.check=Mock()
            r.ready=Mock(side_effect=[m.URLError('refused'),m.HTTPError('http://localhost',503,'unavailable',None,None),None])
            p={'before':{'worker':{}},'images':{'worker':'candidate'},'overrides':{'worker':{'candidate':'override'}},'renders':{'worker':{}}}
            with patch.object(m.core,'rendered',return_value={'image':'candidate'}),patch.object(m.core,'compose',return_value=(['docker','compose'],'/tmp','worker')),patch.object(m.time,'sleep'),patch.object(m.time,'monotonic',return_value=0):r.up(p,'worker')
            self.assertEqual(r.ready.call_count,3)
            record=json.loads((r.root/'worker-readiness-last.private.json').read_text());self.assertEqual(record['exceptionType'],'HTTPError');self.assertEqual(record['httpStatus'],503)
    def test_auth_or_runtime_errors_are_never_startup_transport_retries(self):
        self.assertFalse(m.transient_readiness(m.HTTPError('http://localhost',403,'forbidden',None,None)))
        self.assertFalse(m.transient_readiness(RuntimeError('ENV_CHANGED:engine')))
        self.assertFalse(m.transient_readiness(ValueError('invalid JSON')))
    def test_recovery_cannot_claim_success_if_one_role_did_not_switch(self):
        with tempfile.TemporaryDirectory() as d:
            r=object.__new__(m.Release);r.root=Path(d);r.inspect=Mock(side_effect=RuntimeError('MISSING'));r.up=Mock()
            r.check=Mock(side_effect=[RuntimeError('IMAGE_STATE_INVALID:engine'),None,None])
            with self.assertRaisesRegex(RuntimeError,'CODE_ROLLBACK_REQUIRES_ATTENTION'):r.recover({})
            self.assertEqual(r.up.call_count,3);self.assertEqual(r.check.call_count,3)
            receipt=json.loads((r.root/'recovery.private.json').read_text());self.assertFalse(receipt['allPriorImagesRestored'])
            self.assertEqual(receipt['failures'],{'engine':'IMAGE_STATE_INVALID:engine'})
    def test_engine_idle_is_rechecked_immediately_before_recreate(self):
        r=object.__new__(m.Release);r.input_guard=Mock();r.run=Mock();p={'before':{'engine':{}},'images':{'engine':'new'},'overrides':{'engine':{'candidate':'candidate'}},'renders':{'engine':{}}}
        with patch.object(m.core,'rendered',return_value={'image':'new'}),patch.object(m.core,'idle',side_effect=RuntimeError('ACTIVE_CALLS')),patch.object(m.core,'compose') as compose:
            with self.assertRaisesRegex(RuntimeError,'ACTIVE_CALLS'):r.up(p,'engine')
            compose.assert_not_called();r.run.assert_not_called()
    def offline_fixture(self,directory):
        r=object.__new__(m.Release);r.root=Path(directory);r.bundle=r.root/'bundle';(r.bundle/'tooling').mkdir(parents=True)
        for name in m.OFFLINE:(r.bundle/'tooling'/name).write_text('fixture')
        original=r.root/'original.db';original.write_bytes(b'fixture')
        rows={role:{'Image':image,'Config':{'Env':['UNCHANGED=yes'],'User':'1000:986'}} for role,image in m.IMAGES.items()}
        rows['engine']['Config']['Env']+=['YANDEX_CLOUD_API_KEY=synthetic-key','YANDEX_CLOUD_FOLDER_ID=synthetic-folder']
        p={'before':rows,'database':str(original),'images':{role:'candidate-'+role for role in m.SELECTED},
            'databaseMetadata':{str(original):{'owner':[1000,986,0o600]}},
            'credentialHashes':{k:m.c.sha(v.encode()) for k,v in r.credentials(rows).items()}}
        r.manifest_sha='a'*64;r.crm_backup=Mock(return_value={'path':str(original),'sha256':'b'*64});r.db_guard=Mock()
        snapshot={'ok':True,'snapshot':{'tables':{'normal':{'digest':'unchanged','count':1,'columns':[],'rowid':True}},
            'objects':[{'type':'table','name':'normal','sql':'CREATE TABLE normal(id)'}],'metadata':{}},'tableTypes':{'normal':'table'},'ftsIntegrity':{}}
        startup={k:True for k in ('ok','realAppStart','customerRowsPreserved','schemaPreserved')}
        r.run=Mock(side_effect=[json.dumps(snapshot),json.dumps(startup),json.dumps(snapshot),
            json.dumps({'ok':True,'workerStarted':False,'networkEnabled':False}),
            json.dumps({'ok':True,'providerStarted':False,'networkEnabled':False})])
        return r,p
    def test_offline_gate_uses_only_owner_clone_and_no_network_or_live_migration(self):
        with tempfile.TemporaryDirectory() as d:
            r,p=self.offline_fixture(d)
            with patch.object(m.os,'chown'):gate=r.offline(p)
            self.assertTrue(gate['allLogicalCrmRowsAndSchemaPreserved']);self.assertTrue(gate['ftsIntegrityVerified']);self.assertFalse(gate['liveDatabaseMounted']);self.assertFalse(gate['liveDdlExecuted'])
            commands=[call.args[0] for call in r.run.call_args_list]
            self.assertEqual(len(commands),5)
            self.assertEqual(commands[0][-2:],['/release/snapshot-proof.cjs','snapshot'])
            self.assertEqual(commands[1][-1],'/release/startup-probe.cjs')
            self.assertEqual(commands[2][-2:],['/release/snapshot-proof.cjs','integrity'])
            for command in commands:
                self.assertEqual(command[command.index('--network')+1],'none');self.assertIn('--read-only',command)
                for i,value in enumerate(command):
                    if value=='--mount':self.assertNotIn('src='+str(Path(p['database']).parent)+',',command[i+1])
            self.assertIn('--user',commands[1]);self.assertEqual(commands[1][commands[1].index('--user')+1],'1000:986')
            for file in r.root.glob('*.env'):self.assertEqual(file.stat().st_mode&0o777,0o600)
            r.offline_guard(p)
            env=r.root/'worker-before.private.env';env.write_text('changed')
            with self.assertRaisesRegex(RuntimeError,'OFFLINE_GATE_DRIFT'):r.offline_guard(p)
    def test_actual_startup_all_table_row_or_schema_change_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            r,p=self.offline_fixture(d)
            before=json.loads(r.run.side_effect.__next__());after=copy.deepcopy(before);after['snapshot']['tables']['normal']['digest']='changed'
            r.run.side_effect=[json.dumps(before),json.dumps({k:True for k in ('ok','realAppStart','customerRowsPreserved','schemaPreserved')}),json.dumps(after)]
            with patch.object(m.os,'chown'),self.assertRaisesRegex(RuntimeError,'STARTUP_SCHEMA_OR_ROWS_CHANGED'):r.offline(p)
            self.assertFalse((r.root/'offline-gate.private.json').exists())
    def fts_fixture(self):
        names={'kb_chunks':'CREATE TABLE kb_chunks(id,searchText)',
            'kb_chunks_fts':'CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(searchText)',
            'kb_chunks_fts_data':'CREATE TABLE kb_chunks_fts_data(id,block)',
            'kb_chunks_fts_idx':'CREATE TABLE kb_chunks_fts_idx(segid,term,pgno)'}
        before={'ok':True,'snapshot':{'metadata':{},'objects':[{'type':'table','name':n,'sql':sql} for n,sql in names.items()],
            'tables':{n:{'columns':[],'rowid':True,'count':3,'digest':'same'} for n in names}},
            'tableTypes':{'kb_chunks':'table','kb_chunks_fts':'virtual','kb_chunks_fts_data':'shadow','kb_chunks_fts_idx':'shadow'},'ftsIntegrity':{}}
        after=copy.deepcopy(before);after['ftsIntegrity']={'kb_chunks_fts':True}
        for name in ('kb_chunks_fts_data','kb_chunks_fts_idx'):after['snapshot']['tables'][name].update(count=2,digest='new-physical-segments')
        return before,after
    def test_only_verified_fts5_shadow_physical_rows_may_change(self):
        before,after=self.fts_fixture()
        self.assertEqual(m.compare_startup_snapshots(before,after),['kb_chunks_fts_data','kb_chunks_fts_idx'])
        self.assertIn("VALUES('integrity-check',1)",m.SNAPSHOT_PROOF)
        for name in ('kb_chunks','kb_chunks_fts'):
            b,a=self.fts_fixture();a['snapshot']['tables'][name]['digest']='changed-logical-content'
            with self.assertRaisesRegex(RuntimeError,'STARTUP_SCHEMA_OR_ROWS_CHANGED'):m.compare_startup_snapshots(b,a)
    def test_fts_prefix_or_shadow_like_name_without_both_metadata_proofs_is_not_exempt(self):
        for kind in ('table','shadow'):
            b,a=self.fts_fixture();name='unrelated_fts_data'
            for value in (b,a):
                value['snapshot']['objects'].append({'type':'table','name':name,'sql':'CREATE TABLE unrelated_fts_data(id)'})
                value['snapshot']['tables'][name]={'columns':[],'rowid':True,'count':1,'digest':'original'};value['tableTypes'][name]=kind
            a['snapshot']['tables'][name]['digest']='changed'
            with self.assertRaisesRegex(RuntimeError,'STARTUP_SCHEMA_OR_ROWS_CHANGED'):m.compare_startup_snapshots(b,a)
        b,a=self.fts_fixture();b['tableTypes']['kb_chunks_fts_data']=a['tableTypes']['kb_chunks_fts_data']='table'
        with self.assertRaisesRegex(RuntimeError,'STARTUP_SCHEMA_OR_ROWS_CHANGED'):m.compare_startup_snapshots(b,a)
    def test_fts_integrity_and_shadow_schema_columns_stay_mandatory(self):
        b,a=self.fts_fixture();a['ftsIntegrity']={}
        with self.assertRaisesRegex(RuntimeError,'CLONE_FTS_INTEGRITY_REQUIRED'):m.compare_startup_snapshots(b,a)
        b,a=self.fts_fixture();a['snapshot']['tables']['kb_chunks_fts_data']['columns']=[{'name':'new'}]
        with self.assertRaisesRegex(RuntimeError,'STARTUP_SCHEMA_OR_ROWS_CHANGED'):m.compare_startup_snapshots(b,a)
        b,a=self.fts_fixture();a['snapshot']['objects'][-1]['sql']='ALTERED'
        with self.assertRaisesRegex(RuntimeError,'STARTUP_SCHEMA_OR_ROWS_CHANGED'):m.compare_startup_snapshots(b,a)
    def test_fts_config_content_and_docsize_rows_are_not_segment_exemptions(self):
        for suffix in ('config','content','docsize'):
            b,a=self.fts_fixture();name='kb_chunks_fts_'+suffix
            for value in (b,a):
                value['snapshot']['objects'].append({'type':'table','name':name,'sql':'CREATE TABLE '+name+'(k,v)'})
                value['snapshot']['tables'][name]={'columns':[],'rowid':True,'count':1,'digest':'original'};value['tableTypes'][name]='shadow'
            a['snapshot']['tables'][name]['digest']='changed'
            with self.assertRaisesRegex(RuntimeError,'STARTUP_SCHEMA_OR_ROWS_CHANGED'):m.compare_startup_snapshots(b,a)
    def test_pack_is_committed_only_canonical_and_contains_no_credential_values(self):
        repo=Path(__file__).parents[1];candidate='b'*40;source_tree='c'*40
        def blob(_repo,ref,name,optional=False):
            if name.startswith('scripts/'):
                path=repo/name
                if path.is_file():return path.read_bytes()
            if name.startswith('whatsapp_crm/frontend/') or name in ('requirements.txt','requirements-optional.txt','whatsapp_crm/package.json','whatsapp_crm/package-lock.json'):return b'unchanged-dependency'
            relative=name.removeprefix('whatsapp_crm/')
            status=m.CRM.get(relative) if name.startswith('whatsapp_crm/') else m.ENGINE.get(name)
            if ref==m.BASE and status=='A':return None
            return ('committed-'+ref+'-'+name).encode()
        changes={**{'whatsapp_crm/'+n:s for n,s in m.CRM.items()},**m.ENGINE,**m.FRONTEND}
        diff=b''.join(s.encode()+b'\0'+n.encode()+b'\0' for n,s in changes.items())
        def git(_repo,*args):
            if args[0]=='diff':return diff
            if args[0]=='rev-parse':return source_tree.encode()
            return b''
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);dist=root/'dist';dist.mkdir();(dist/'index.html').write_text('exact frontend')
            receipt={'sourceCommit':candidate,'files':m.c.tree(dist),'builtFromFreshGitExport':True,'sourceTree':source_tree,
                'builderSha256':m.c.sha(blob(repo,candidate,'scripts/customer-completion-release/build_frontend.py')),
                'lockSha256':m.c.sha(b'unchanged-dependency')}
            receipt_file=root/'receipt.json';receipt_file.write_text(json.dumps(receipt));archive=root/'release.tar'
            with patch.object(m.c,'git',side_effect=git),patch.object(m.c,'blob',side_effect=blob),patch.object(m.c,'commit',return_value=candidate):
                result=m.pack(SimpleNamespace(repo=repo,candidate=candidate,frontend_dist=dist,frontend_receipt=receipt_file,output=archive))
            with tarfile.open(archive) as bundle:
                entries=bundle.getmembers();self.assertEqual([e.name for e in entries],sorted(e.name for e in entries))
                self.assertTrue(all(e.isfile() and e.mtime==0 and e.uid==e.gid==0 for e in entries))
                manifest=json.load(bundle.extractfile('manifest.json'))
                self.assertEqual(manifest['environmentAdditionNames'],list(m.ENV_ADDITIONS))
                self.assertNotIn('credentialHashes',manifest);self.assertNotIn('environment',manifest)
                self.assertEqual(manifest['environmentSource']['image'],m.IMAGES['engine'])
                self.assertEqual(bundle.extractfile('payload/worker/src/services/database.service.js').read(),blob(repo,candidate,'whatsapp_crm/src/services/database.service.js'))
                self.assertNotIn('payload/worker/frontend/dist/index.html',[e.name for e in entries])
                self.assertTrue(manifest['services']['crm']['preimages']['src/services/voice-options.service.js'])
                self.assertIsNone(manifest['services']['worker']['preimages']['src/services/voice-waiting.service.js'])
            self.assertEqual(result['archiveSha256'],m.c.file_sha(archive))

if __name__=='__main__':unittest.main()
