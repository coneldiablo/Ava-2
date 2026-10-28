import copy,importlib.util,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import Mock,patch
S=importlib.util.spec_from_file_location('post_call_release',Path(__file__).with_name('post-call-release.py'))
m=importlib.util.module_from_spec(S);S.loader.exec_module(m)

class PostCallReleaseTests(unittest.TestCase):
    def gate(self,changes=None,dependency=None):
        changes=changes if changes is not None else {**{'whatsapp_crm/'+n:s for n,s in m.CRM.items()},**m.FRONTEND}
        diff=b''.join(status.encode()+b'\0'+name.encode()+b'\0' for name,status in changes.items())
        def blob(repo,ref,name,optional=False):return b'changed' if ref=='candidate' and name==dependency else b'old'
        with patch.object(m.c,'git',side_effect=lambda repo,*args:diff if args[0]=='diff' else b''),patch.object(m.c,'blob',side_effect=blob):m.source_scope(Path('/repo'),'candidate')
    def test_exact_runtime_baseline_and_only_two_mutable_roles(self):
        self.assertEqual(m.BASE,'4555c9e71f16bddd8cd598cec2fabd3230ade083');self.assertEqual(m.SELECTED,('worker','crm'))
        self.assertEqual(m.IMAGES['crm'],'sha256:ef90e58cbd70ce35bf14a10293fec9318150d1af85a8a1a983cc05bff877d374')
        self.assertEqual(m.IMAGES['worker'],'sha256:23a1cb80861209d93fd5a7d2dee4d2b3db8900ff9b718288a002193f7917724d')
        self.assertEqual(m.ENV_ADDITIONS,());self.assertEqual(m.ENGINE,{});self.assertEqual(m.WORKER,m.CRM)
    def test_exact_backend_ui_statuses_and_cyrillic_docs(self):
        changes={**{'whatsapp_crm/'+n:s for n,s in m.CRM.items()},**m.FRONTEND,'docs/Отчёт.md':'M'};self.gate(changes)
        changes['whatsapp_crm/src/services/postcall-followup.service.js']='M'
        with self.assertRaisesRegex(RuntimeError,'EXACT_RUNTIME_STATUS'):self.gate(changes)
    def test_any_other_runtime_or_missing_expected_file_is_rejected(self):
        changes={**{'whatsapp_crm/'+n:s for n,s in m.CRM.items()},**m.FRONTEND}
        for name in ('src/engine.py','src/providers/neuro_gemini.py','whatsapp_crm/src/services/voice-options.service.js','whatsapp_crm/frontend/src/pages/Dashboard.tsx'):
            with self.assertRaisesRegex(RuntimeError,'OUTSIDE_POST_CALL_SCOPE'):self.gate({**changes,name:'M'})
        changes.pop('whatsapp_crm/src/services/database.service.js')
        with self.assertRaisesRegex(RuntimeError,'EXACT_RUNTIME_CHANGESET'):self.gate(changes)
    def test_dependencies_and_env_stay_exact(self):
        with self.assertRaisesRegex(RuntimeError,'DEPENDENCIES_CHANGED'):self.gate(dependency='whatsapp_crm/package-lock.json')
        r=object.__new__(m.Release);before={'crm':{'Config':{'Env':['YANDEX_CLOUD_API_KEY=synthetic','UNCHANGED=yes']}},'worker':{'Config':{'Env':['NO_ADDITIONS=yes']}}}
        for role in ('crm','worker'):
            self.assertEqual(r.expected_env({'before':before},role),m.core.envmap(before[role]))
            self.assertEqual(r.expected_env({'before':before},role,True),m.core.envmap(before[role]))
    def test_engine_recreation_is_explicitly_forbidden_before_any_command(self):
        r=object.__new__(m.Release);r.input_guard=Mock();r.run=Mock()
        with self.assertRaisesRegex(RuntimeError,'ENGINE_MUTATION_FORBIDDEN'):r.up({},'engine')
        r.input_guard.assert_not_called();r.run.assert_not_called()
    def test_fresh_mtime_context_and_whole_tree_retains_voice_fixes(self):
        with tempfile.TemporaryDirectory() as d:
            source=Path(d)/'source';source.mkdir();file=source/'index.html';file.write_bytes(b'n'*507);os.utime(file,ns=(0,0))
            target=Path(d)/'context';m.copy_context(source,target);self.assertEqual(m.c.tree(source),m.c.tree(target));self.assertGreater((target/'index.html').stat().st_mtime_ns,0)
        base={'src/services/yandex-voice-preview.service.js':'yandex','src/services/voice-waiting.service.js':'waiting','src/services/sales-brain.service.js':'old','assets/audio/office-ambience.wav':'ambient','frontend/dist/index.html':'old-ui','node_modules/production-only':'preserve'}
        payload={'src/services/sales-brain.service.js':'new','frontend/dist/index.html':'new-ui'}
        self.assertEqual(m.c.expected_tree(base,payload,True),{**base,**payload})
    def test_all_other_containers_include_engine_identity_and_full_runtime(self):
        rows=[]
        for role,name in m.NAMES.items():rows.append({'Name':'/'+name,'Id':'id-'+role,'Image':m.IMAGES[role],'State':{'Running':True,'StartedAt':'same'},'RestartCount':0,'Config':{'Env':['SECRET=synthetic']},'Mounts':[],'HostConfig':{'Binds':None},'NetworkSettings':{'Networks':{}}})
        r=object.__new__(m.Release);r.run=Mock(side_effect=['ids',json.dumps(rows)]);others=r.others()
        self.assertEqual(set(others),{'/ai_engine','/admin_ui'});self.assertEqual(others['/ai_engine'][0],'id-engine');self.assertEqual(others['/ai_engine'][-1]['env'],{'SECRET':'synthetic'})
    def test_only_host_bind_order_normalized(self):
        before={'Binds':['/a:/app/data:rw','/b:/app/config:ro'],'Privileged':False}
        self.assertEqual(m.normalized_host_config(before),m.normalized_host_config({**before,'Binds':list(reversed(before['Binds']))}))
        with self.assertRaisesRegex(RuntimeError,'COLLISION'):m.normalized_host_config({'Binds':['/a:/app/data:rw','/b:/app/data:ro']})
        self.assertNotEqual(m.normalized_host_config(before),m.normalized_host_config({**before,'Privileged':True}))
    def test_db_inode_and_wal_metadata_and_required_offline_gate(self):
        with tempfile.TemporaryDirectory() as d:
            r=object.__new__(m.Release);r.root=Path(d);file=r.root/'db';file.write_bytes(b'fixture');file.chmod(0o600)
            p={'databaseMetadata':{str(file):r.metadata(file)}};side=Path(str(file)+'-wal');side.write_bytes(b'x');side.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError,'DATABASE_SIDECAR_CHANGED'):r.db_guard(p)
            side.unlink();new=r.root/'replacement';new.write_bytes(b'fixture');new.chmod(0o600);new.replace(file)
            with self.assertRaisesRegex(RuntimeError,'DATABASE_METADATA_CHANGED'):r.db_guard(p)
            r.load=Mock(return_value={});r.crm_backup=Mock();r.up=Mock()
            with self.assertRaisesRegex(RuntimeError,'OFFLINE_GATE_REQUIRED'):r.apply()
            r.crm_backup.assert_not_called();r.up.assert_not_called()
    def fts(self):
        names={'kb_chunks':'CREATE TABLE kb_chunks(id,searchText)','kb_chunks_fts':'CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(searchText)','kb_chunks_fts_data':'CREATE TABLE kb_chunks_fts_data(id,block)'}
        b={'ok':True,'snapshot':{'metadata':{},'objects':[{'type':'table','name':n,'sql':sql} for n,sql in names.items()],
            'tables':{n:{'columns':[],'rowid':True,'count':3,'digest':'original'} for n in names}},'tableTypes':{'kb_chunks':'table','kb_chunks_fts':'virtual','kb_chunks_fts_data':'shadow'},'ftsIntegrity':{}}
        a=copy.deepcopy(b);a['ftsIntegrity']={'kb_chunks_fts':True};a['snapshot']['tables']['kb_chunks_fts_data']['digest']='physical-churn';return b,a
    def test_fts5_only_physical_segments_exempt_with_real_metadata_integrity_and_logical_rows(self):
        b,a=self.fts();self.assertEqual(m.compare_startup_snapshots(b,a),['kb_chunks_fts_data'])
        for name in ('kb_chunks','kb_chunks_fts'):
            b,a=self.fts();a['snapshot']['tables'][name]['digest']='changed'
            with self.assertRaisesRegex(RuntimeError,'STARTUP_SCHEMA_OR_ROWS_CHANGED'):m.compare_startup_snapshots(b,a)
        b,a=self.fts();a['ftsIntegrity']={}
        with self.assertRaisesRegex(RuntimeError,'CLONE_FTS_INTEGRITY_REQUIRED'):m.compare_startup_snapshots(b,a)
    def test_partial_recovery_preserves_first_failure_and_attempts_both_roles(self):
        with tempfile.TemporaryDirectory() as d:
            r=object.__new__(m.Release);r.root=Path(d);r.inspect=Mock(side_effect=RuntimeError('MISSING'));r.up=Mock(side_effect=[RuntimeError('FIRST_FAILURE'),None]);r.check=Mock(side_effect=[RuntimeError('IMAGE_STATE_INVALID:worker'),None])
            with self.assertRaisesRegex(RuntimeError,'CODE_ROLLBACK_REQUIRES_ATTENTION'):r.recover({})
            self.assertEqual([c.args[1] for c in r.up.call_args_list],['worker','crm'])
            receipt=json.loads((r.root/'recovery.private.json').read_text());self.assertEqual(receipt['failures']['worker'],'FIRST_FAILURE');self.assertEqual(receipt['finalReadbackFailures']['worker'],'IMAGE_STATE_INVALID:worker')
    def test_bounded_transient_readiness_still_rejects_auth_and_runtime_drift(self):
        self.assertTrue(m.transient_readiness(m.URLError('refused')));self.assertTrue(m.transient_readiness(m.HTTPError('url',503,'starting',None,None)))
        self.assertFalse(m.transient_readiness(m.HTTPError('url',403,'forbidden',None,None)));self.assertFalse(m.transient_readiness(RuntimeError('ENV_CHANGED:crm')))
    def test_actual_committed_runtime_preimages_and_new_service_absence(self):
        repo=Path(__file__).parents[1]
        for name,status in m.CRM.items():self.assertEqual(m.c.blob(repo,m.BASE,'whatsapp_crm/'+name,optional=True) is None,status=='A')
    def test_real_entrypoint_clone_contract_has_no_engine_container_and_hash_binds_env(self):
        with tempfile.TemporaryDirectory() as d:
            r=object.__new__(m.Release);r.root=Path(d);r.bundle=r.root/'bundle';(r.bundle/'tooling').mkdir(parents=True)
            for name in m.OFFLINE:(r.bundle/'tooling'/name).write_text('frozen-fixture')
            original=r.root/'original.db';original.write_bytes(b'fixture');r.crm_backup=Mock(return_value={'path':str(original)});r.db_guard=Mock();r.manifest_sha='a'*64
            row={'Config':{'Env':['UNCHANGED=fixture','YANDEX_CLOUD_API_KEY=preserved-fixture'],'User':'1000:986'}}
            p={'before':{role:copy.deepcopy(row) for role in m.SELECTED},'database':str(original),'databaseMetadata':{str(original):{'owner':[1000,986,0o600]}},'images':{'crm':'candidate-crm','worker':'candidate-worker'}}
            snapshot={'ok':True,'snapshot':{'metadata':{},'objects':[{'type':'table','name':'normal','sql':'CREATE TABLE normal(id)'}],
                'tables':{'normal':{'columns':[],'rowid':True,'count':1,'digest':'same'}}},'tableTypes':{'normal':'table'},'ftsIntegrity':{}}
            startup={k:True for k in ('ok','realAppStart','customerRowsPreserved','schemaPreserved')}
            r.run=Mock(side_effect=[json.dumps(snapshot),json.dumps(startup),json.dumps(snapshot),json.dumps({'ok':True,'workerStarted':False,'networkEnabled':False})])
            with patch.object(m.os,'chown'):result=r.offline(p)
            commands=[call.args[0] for call in r.run.call_args_list];self.assertEqual(len(commands),4)
            for command in commands:
                self.assertIn('--read-only',command);self.assertEqual(command[command.index('--network')+1],'none');self.assertNotIn('python',command);self.assertNotIn(m.IMAGES['engine'],command)
            self.assertFalse(result['liveDatabaseMounted']);self.assertFalse(result['liveDdlExecuted']);self.assertTrue(result['allLogicalCrmRowsAndSchemaPreserved'])
            self.assertEqual((r.root/'crm-candidate.private.env').stat().st_mode&0o777,0o600);r.offline_guard(p)
            (r.root/'crm-candidate.private.env').write_text('mutated')
            with self.assertRaisesRegex(RuntimeError,'OFFLINE_GATE_DRIFT'):r.offline_guard(p)

if __name__=='__main__':unittest.main()
