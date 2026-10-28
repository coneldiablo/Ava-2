"""Bounded offline safety tests; no Docker, production or provider operations."""
import copy, importlib.util, json, os, subprocess, tempfile, unittest
from pathlib import Path
from unittest.mock import Mock, patch
S=importlib.util.spec_from_file_location('product_journeys_release',Path(__file__).with_name('product-journeys-release.py'))
m=importlib.util.module_from_spec(S);S.loader.exec_module(m)

class ProductJourneysReleaseTests(unittest.TestCase):
    def changes(self):
        return {**{'whatsapp_crm/'+n:s for n,s in m.CRM.items()},**m.ENGINE,**m.FRONTEND,m.CONFIG_SOURCE:'M',**m.HOST_SEPARATE}
    def gate(self,changes=None,dependency=None):
        changes=self.changes() if changes is None else changes
        diff=b''.join(s.encode()+b'\0'+n.encode()+b'\0' for n,s in changes.items())
        def blob(repo,ref,name,optional=False):return b'changed' if ref=='candidate' and name==dependency else b'old'
        with patch.object(m.c,'git',side_effect=lambda repo,*a:diff if a[0]=='diff' else b''),patch.object(m.c,'blob',side_effect=blob):m.source_scope(Path('/repo'),'candidate')
    def test_exact_three_roles_latest_pins_and_no_environment_changes(self):
        self.assertEqual(m.BASE,'ed5ada5a61c193f7b643c1d67adfd83ddcdc9607')
        self.assertEqual(m.SELECTED,('worker','crm','engine'));self.assertEqual(m.ENV_ADDITIONS,())
        self.assertEqual(m.IMAGES['crm'],'sha256:992cc5b55c076c0bc04416cc0b137f3ef3aaeec31a494d513bd9beb1b5300e00')
        self.assertEqual(m.IMAGES['worker'],'sha256:d71484206a17f644f41088231cdb80f76bea97fde818373e7b5522daefae2857')
        self.assertEqual(set(m.ENGINE),{'src/mcp_servers/sales_brain_mcp_server.py','src/tools/context.py','src/tools/mcp_tool.py'})
        self.assertEqual(m.WORKER,m.CRM);self.assertNotIn('config/ai-agent.yaml',m.ENGINE)
        for role in m.SELECTED:
            r=object.__new__(m.Release);p={'before':{role:{'Config':{'Env':['SECRET=fixture','DONT_CHANGE=yes']}}}}
            self.assertEqual(r.expected_env(p,role),{'SECRET':'fixture','DONT_CHANGE':'yes'})
            self.assertEqual(r.expected_env(p,role,True),r.expected_env(p,role))
    def test_exact_source_scope_rejects_missing_statuses_unowned_runtime_and_dependencies(self):
        self.gate({**self.changes(),'docs/Отчёт.md':'M'})
        for name in ('src/engine.py','src/providers/neuro_gemini.py','whatsapp_crm/src/services/voice-options.service.js'):
            with self.assertRaisesRegex(RuntimeError,'OUTSIDE_PRODUCT_JOURNEYS_SCOPE'):self.gate({**self.changes(),name:'M'})
        missing=self.changes();missing.pop(m.CONFIG_SOURCE)
        with self.assertRaisesRegex(RuntimeError,'EXACT_RUNTIME_CHANGESET_REQUIRED'):self.gate(missing)
        with self.assertRaisesRegex(RuntimeError,'EXACT_RUNTIME_STATUS_REQUIRED'):self.gate({**self.changes(),'whatsapp_crm/src/services/telephony/external-sip.js':'M'})
        with self.assertRaisesRegex(RuntimeError,'DEPENDENCIES_CHANGED'):self.gate(dependency='whatsapp_crm/package-lock.json')
    def test_all_runtime_preimages_match_actual_committed_baseline(self):
        repo=Path(__file__).parents[1]
        for name,status in self.changes().items():self.assertEqual(m.c.blob(repo,m.BASE,name,optional=True) is None,status=='A',name)
    def yaml(self):
        ns={'__name__':'_release_test'};exec(m.YAML_PATCH_SCRIPT,ns)
        repo=Path(__file__).parents[1];base=m.c.blob(repo,m.BASE,m.CONFIG_SOURCE).decode();candidate=(repo/m.CONFIG_SOURCE).read_text()
        return ns,base,candidate
    def test_yaml_exact_candidate_and_preserves_prod_only_bytes_comments_and_providers(self):
        ns,base,candidate=self.yaml();out,receipt=ns['patch_config'](base,base,candidate)
        self.assertEqual(ns['load'](out),ns['load'](candidate));self.assertTrue(receipt['unrelatedBytesPreserved'])
        # Realistic production-only extra config and voice/endpoint values survive.
        live=base+'\n# PRIVATE PRODUCTION SENTINEL\nproduction_test_only:\n  voice: real-production-voice\n  endpoint: https://private.invalid\n  proxy: keep-this-byte-string\n'
        out,receipt=ns['patch_config'](live,base,candidate)
        self.assertEqual(ns['load'](out),ns['load'](candidate+live[len(base):]));self.assertTrue(out.endswith(live[len(base):]));self.assertEqual(len(receipt['changedPaths']),4)
    def test_yaml_rejects_outside_projection_duplicate_tools_wrong_preimage_and_duplicate_keys(self):
        ns,base,candidate=self.yaml()
        with self.assertRaisesRegex(RuntimeError,'OUTSIDE_APPROVED_SCOPE'):ns['patch_config'](base,base,candidate+'\nunreviewed_provider: true\n')
        with self.assertRaisesRegex(RuntimeError,'PREIMAGE'):ns['patch_config'](candidate,base,candidate)
        with self.assertRaisesRegex(RuntimeError,'PREIMAGE'):ns['patch_config'](base.replace('Risky writes are only WhatsApp sending','SOMEONE EDITED THIS'),base,candidate)
        with self.assertRaisesRegex(RuntimeError,'DUPLICATE_KEY'):ns['patch_config'](base+'\ncontexts: {}\n',base,candidate)
    def test_quoted_and_wrapped_live_yaml_uses_same_exact_parsed_preimage(self):
        ns,base,candidate=self.yaml();import yaml
        # Same representation as actual production, without any production keys.
        live=yaml.safe_dump(yaml.safe_load(base),sort_keys=False,allow_unicode=True,width=75)
        node=ns['node_at'](live,('contexts','demo_google_live','prompt'));self.assertEqual(node.style,"'")
        sentinel='\n# PRIVATE SENTINEL STAYS BYTE EXACT\nprod_only:\n  voice: synthetic-voice\n  proxy: https://synthetic.invalid\n'
        out,receipt=ns['patch_config'](live+sentinel,base,candidate)
        self.assertEqual(ns['load'](out),ns['load'](candidate+sentinel));self.assertTrue(out.endswith(sentinel))
        self.assertTrue(receipt['unrelatedBytesPreserved']);self.assertEqual(ns['node_at'](out,('contexts','demo_google_live','prompt')).style,'|')
        # All untouched top-level raw spans (providers included) remain exact.
        before_node=yaml.compose(live+sentinel);after_node=yaml.compose(out)
        before={k.value:(live+sentinel)[v.start_mark.index:v.end_mark.index] for k,v in before_node.value}
        after={k.value:out[v.start_mark.index:v.end_mark.index] for k,v in after_node.value}
        for key in set(before)-{'contexts','mcp'}:self.assertEqual(before[key],after[key],key)
    def test_exact_worker_historical_refs_are_ancestors_and_match_actual_approved_bytes(self):
        repo=Path(__file__).parents[1]
        self.assertEqual(set(m.PREIMAGE_SOURCES),{'worker'});self.assertEqual(len(m.PREIMAGE_SOURCES['worker']),2)
        for name,pin in m.PREIMAGE_SOURCES['worker'].items():
            old=m.preimage(repo,'worker',name);self.assertEqual(m.c.sha(old),pin['sha256'])
            self.assertEqual(old,m.c.blob(repo,pin['sourceRef'],'whatsapp_crm/'+name))
            self.assertNotEqual(old,m.preimage(repo,'crm',name))
        self.assertEqual(m.preimage_sources('crm'),{});self.assertEqual(m.preimage_sources('engine'),{})
    def test_historical_hash_and_ancestry_are_required_not_optional_preimage_exceptions(self):
        pin=m.PREIMAGE_SOURCES['worker']['src/services/rag.service.js']
        with patch.object(m.c,'git',return_value=b'') as git,patch.object(m.c,'blob',return_value=b'unreviewed bytes'):
            with self.assertRaisesRegex(RuntimeError,'HISTORICAL_PREIMAGE_SOURCE_DRIFT'):m.preimage(Path('/repo'),'worker','src/services/rag.service.js')
            git.assert_called_once_with(Path('/repo'),'merge-base','--is-ancestor',pin['sourceRef'],m.BASE)
        with patch.object(m.c,'git',side_effect=RuntimeError('ANCESTRY_REQUIRED')),patch.object(m.c,'blob') as blob:
            with self.assertRaisesRegex(RuntimeError,'ANCESTRY_REQUIRED'):m.preimage(Path('/repo'),'worker','src/services/rag.service.js')
            blob.assert_not_called()
        # A new/unlisted path keeps the ordinary BASE preimage contract.
        with patch.object(m.c,'blob',return_value=b'base') as blob:
            self.assertEqual(m.preimage(Path('/repo'),'worker','src/services/database.service.js'),b'base')
            blob.assert_called_once_with(Path('/repo'),m.BASE,'whatsapp_crm/src/services/database.service.js',optional=True)
    def test_fresh_build_context_and_whole_image_fence_preserve_prod_only_files(self):
        with tempfile.TemporaryDirectory() as d:
            source=Path(d)/'src';source.mkdir();file=source/'asset';file.write_text('new');os.utime(file,ns=(0,0))
            target=Path(d)/'ctx';m.copy_context(source,target);self.assertEqual(m.c.tree(source),m.c.tree(target));self.assertGreater((target/'asset').stat().st_mtime_ns,0)
        base={'node_modules/prod-only':'dep','assets/audio/office.wav':'ambient','src/providers/neuro_vertex.py':'voice','frontend/dist/obsolete.js':'old'}
        self.assertEqual(m.c.expected_tree(base,{'frontend/dist/index.html':'new'},True),{k:v for k,v in base.items() if not k.startswith('frontend/dist/')}|{'frontend/dist/index.html':'new'})
    def test_only_other_containers_are_fenced_including_admin_runtime(self):
        rows=[{'Name':'/'+n,'Id':r,'Image':m.IMAGES[r],'State':{'Running':True,'StartedAt':'same'},'RestartCount':0,'Config':{'Env':['SECRET=fixture']},'Mounts':[],'HostConfig':{'Binds':None},'NetworkSettings':{'Networks':{}}} for r,n in m.NAMES.items()]
        r=object.__new__(m.Release);r.run=Mock(side_effect=['ids',json.dumps(rows)]);others=r.others()
        self.assertEqual(set(others),{'/admin_ui'});self.assertEqual(others['/admin_ui'][-1]['env'],{'SECRET':'fixture'})
    def test_only_bind_order_normalized_not_security_or_destinations(self):
        b={'Binds':['/a:/app/data:rw','/b:/app/config:ro'],'Privileged':False}
        self.assertEqual(m.normalized_host_config(b),m.normalized_host_config({**b,'Binds':list(reversed(b['Binds']))}))
        with self.assertRaisesRegex(RuntimeError,'COLLISION'):m.normalized_host_config({'Binds':['/a:/app/data:rw','/b:/app/data:ro']})
        self.assertNotEqual(m.normalized_host_config(b),m.normalized_host_config({**b,'Privileged':True}))
    def test_db_inode_wal_metadata_and_required_offline_gate(self):
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
        objects=[{'type':'table','name':n,'sql':sql} for n,sql in {'normal':'CREATE TABLE normal(id)','f':'CREATE VIRTUAL TABLE f USING fts5(text)','f_data':'CREATE TABLE f_data(id,block)'}.items()]
        b={'ok':True,'snapshot':{'metadata':{},'objects':objects,'tables':{o['name']:{'columns':[],'rowid':True,'count':3,'digest':'old'} for o in objects}},'tableTypes':{'normal':'table','f':'virtual','f_data':'shadow'},'ftsIntegrity':{}}
        a=copy.deepcopy(b);a['ftsIntegrity']={'f':True};a['snapshot']['tables']['f_data']['digest']='repacked';return b,a
    def test_fts_only_physical_shadow_with_logical_equivalence_and_integrity(self):
        b,a=self.fts();self.assertEqual(m.compare_startup_snapshots(b,a),['f_data'])
        for name in ('normal','f'):
            b,a=self.fts();a['snapshot']['tables'][name]['digest']='changed'
            with self.assertRaisesRegex(RuntimeError,'STARTUP_SCHEMA_OR_ROWS_CHANGED'):m.compare_startup_snapshots(b,a)
        b,a=self.fts();a['ftsIntegrity']={}
        with self.assertRaisesRegex(RuntimeError,'CLONE_FTS_INTEGRITY_REQUIRED'):m.compare_startup_snapshots(b,a)
        b,a=self.fts();b['tableTypes']['f_data']=a['tableTypes']['f_data']='table'
        with self.assertRaisesRegex(RuntimeError,'STARTUP_SCHEMA_OR_ROWS_CHANGED'):m.compare_startup_snapshots(b,a)
    def config_state(self,d):
        r=object.__new__(m.Release);r.root=Path(d);path=r.root/'live.yaml';old=b'old';new=b'new';path.write_bytes(old);path.chmod(0o640)
        backup=r.root/'before.yaml';backup.write_bytes(old);stage=r.root/'staged.yaml';stage.write_bytes(new)
        stat=path.stat();parent=path.parent.stat();state={'beforeFile':str(backup),'stagedFile':str(stage),'beforeSha256':m.c.sha(old),'afterSha256':m.c.sha(new),'owner':[stat.st_uid,stat.st_gid,0o640],'directory':[parent.st_dev,parent.st_ino,parent.st_uid,parent.st_gid,parent.st_mode&0o777]}
        inputs={'files':{'compose':'same'},'bindings':{str(path):[m.c.sha(old),stat.st_uid,stat.st_gid,0o640],'sibling-secret':['keep',0,0,0o600]}}
        p={'configuration':state,'before':{'engine':{'Config':{'Env':[]}}},'images':{'engine':'candidate'},'inputs':inputs}
        def current(_):
            value=copy.deepcopy(inputs);value['bindings'][str(path)][0]=m.c.file_sha(path);return value
        r.inputs=Mock(side_effect=current)
        return r,path,p
    def test_configuration_input_projection_allows_only_known_own_hash_not_sibling_drift(self):
        with tempfile.TemporaryDirectory() as d:
            r,path,p=self.config_state(d)
            with patch.object(m,'CONFIG_PATH',str(path)),patch.object(m,'CONFIG_SHA',p['configuration']['beforeSha256']):
                r.configuration_guard(p);path.write_bytes(b'new');r.configuration_guard(p)
                path.write_bytes(b'unexpected')
                with self.assertRaisesRegex(RuntimeError,'LIVE_CONFIGURATION_DRIFT'):r.configuration_guard(p)
                path.write_bytes(b'new');r.inputs=Mock(return_value={**p['inputs'],'files':{'compose':'changed'}})
                with self.assertRaisesRegex(RuntimeError,'CONFIG_INPUT_DRIFT'):r.configuration_guard(p)
    def test_active_call_rejects_before_stop_or_live_config_write(self):
        with tempfile.TemporaryDirectory() as d:
            r,path,p=self.config_state(d);r.run=Mock();r.inspect=Mock()
            with patch.object(m,'CONFIG_PATH',str(path)),patch.object(m,'CONFIG_SHA',p['configuration']['beforeSha256']),patch.object(m.core,'idle',side_effect=RuntimeError('ACTIVE_CALLS')):
                with self.assertRaisesRegex(RuntimeError,'ACTIVE_CALLS'):r.switch_configuration(p)
            self.assertEqual(path.read_bytes(),b'old');r.run.assert_not_called();r.inspect.assert_not_called()
    def test_engine_idle_stop_atomic_configuration_readback_and_exact_rollback(self):
        with tempfile.TemporaryDirectory() as d:
            r,path,p=self.config_state(d);r.run=Mock();r.inspect=Mock(side_effect=[{'Image':m.IMAGES['engine']},{'State':{'Running':False}},{'Image':'candidate'},{'State':{'Running':False}}])
            with patch.object(m,'CONFIG_PATH',str(path)),patch.object(m,'CONFIG_SHA',p['configuration']['beforeSha256']),patch.object(m.core,'idle') as idle,patch.object(m.core,'compose',return_value=(['docker','compose'],'/tmp','engine')):
                r.switch_configuration(p);self.assertEqual(path.read_bytes(),b'new');self.assertEqual(path.stat().st_mode&0o777,0o640)
                r.switch_configuration(p,True);self.assertEqual(path.read_bytes(),b'old');self.assertEqual(idle.call_count,4)
            self.assertEqual([call.args[0][-4:] for call in r.run.call_args_list],[['stop','--timeout','30','engine']]*2)
    def test_verify_requires_selected_candidate_or_exact_rollback_yaml(self):
        with tempfile.TemporaryDirectory() as d:
            r,path,p=self.config_state(d);r.load=Mock(return_value=p);r.input_guard=Mock();r.check=Mock(side_effect=RuntimeError('CHECK_REACHED'))
            with patch.object(m,'CONFIG_PATH',str(path)),patch.object(m,'CONFIG_SHA',p['configuration']['beforeSha256']):
                with self.assertRaisesRegex(RuntimeError,'INSTALLED_CONFIGURATION_DRIFT'):r.verify()
                path.write_bytes(b'new')
                with self.assertRaisesRegex(RuntimeError,'CHECK_REACHED'):r.verify()
                with self.assertRaisesRegex(RuntimeError,'INSTALLED_CONFIGURATION_DRIFT'):r.verify(True)
                path.write_bytes(b'old')
                with self.assertRaisesRegex(RuntimeError,'CHECK_REACHED'):r.verify(True)
    def test_partial_recovery_attempts_all_roles_and_retains_first_failure_no_db_restore(self):
        with tempfile.TemporaryDirectory() as d:
            r=object.__new__(m.Release);r.root=Path(d);r.inspect=Mock(side_effect=RuntimeError('MISSING'));r.up=Mock(side_effect=[RuntimeError('FIRST_FAILURE'),None,None]);r.check=Mock(side_effect=[RuntimeError('IMAGE_STATE_INVALID:worker'),None,None])
            with self.assertRaisesRegex(RuntimeError,'CODE_ROLLBACK_REQUIRES_ATTENTION'):r.recover({})
            self.assertEqual([call.args[1] for call in r.up.call_args_list],list(m.SELECTED))
            receipt=json.loads((r.root/'recovery.private.json').read_text());self.assertEqual(receipt['failures']['worker'],'FIRST_FAILURE');self.assertFalse(receipt['databaseRestored'])
    def test_bounded_readiness_auth_and_runtime_drift_are_not_retried(self):
        self.assertTrue(m.transient_readiness(m.URLError('refused')));self.assertTrue(m.transient_readiness(m.HTTPError('u',503,'starting',None,None)))
        self.assertFalse(m.transient_readiness(m.HTTPError('u',403,'denied',None,None)));self.assertFalse(m.transient_readiness(RuntimeError('ENV_CHANGED:crm')))
    def test_real_app_clone_and_all_imports_are_no_network_no_live_db_and_env_bound(self):
        with tempfile.TemporaryDirectory() as d:
            r=object.__new__(m.Release);r.root=Path(d);r.bundle=r.root/'bundle';(r.bundle/'tooling').mkdir(parents=True)
            for name in m.OFFLINE:(r.bundle/'tooling'/name).write_text('fixture')
            original=r.root/'original.db';original.write_bytes(b'fixture');r.crm_backup=Mock(return_value={'path':str(original)});r.db_guard=Mock();r.manifest_sha='a'*64
            row={'Config':{'Env':['UNCHANGED=fixture'],'User':'1000:986'}}
            p={'before':{role:copy.deepcopy(row) for role in m.SELECTED},'database':str(original),'databaseMetadata':{str(original):{'owner':[1000,986,0o600]}},'images':{role:'candidate-'+role for role in m.SELECTED}}
            snapshot={'ok':True,'snapshot':{'metadata':{},'objects':[],'tables':{}},'tableTypes':{},'ftsIntegrity':{}}
            startup={k:True for k in ('ok','realAppStart','customerRowsPreserved','schemaPreserved')}
            r.run=Mock(side_effect=[json.dumps(snapshot),json.dumps(startup),json.dumps(snapshot),json.dumps({'ok':True,'workerStarted':False}),json.dumps({'ok':True,'providerStarted':False})])
            with patch.object(m.os,'chown'):receipt=r.offline(p)
            self.assertEqual(len(r.run.call_args_list),5)
            for call in r.run.call_args_list:
                command=call.args[0];self.assertIn('--read-only',command);self.assertEqual(command[command.index('--network')+1],'none');self.assertNotIn('/app/data/crm_v2.db',command)
                self.assertNotIn('type=bind,src='+str(original.parent)+',dst=/source',command)
            self.assertFalse(receipt['liveDatabaseMounted']);self.assertFalse(receipt['liveDdlExecuted']);r.offline_guard(p)
            (r.root/'engine-before.private.env').write_text('mutated')
            with self.assertRaisesRegex(RuntimeError,'OFFLINE_GATE_DRIFT'):r.offline_guard(p)

if __name__=='__main__':unittest.main()
