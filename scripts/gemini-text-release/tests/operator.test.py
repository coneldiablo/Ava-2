import importlib.util, pathlib, tempfile, unittest, json, copy, sqlite3, types, contextlib, io
from unittest.mock import patch
P=pathlib.Path(__file__).resolve().parents[1]/'release_operator.py'
spec=importlib.util.spec_from_file_location('text_op',P); op=importlib.util.module_from_spec(spec);spec.loader.exec_module(op)
real_engine_ready = op.engine_ready
I=lambda c:'sha256:'+c*64
class FakeADC:
 def __init__(self,path):self.path=path
 def __str__(self):return str(self.path)
 def __fspath__(self):return str(self.path)
 def is_file(self):return True
 def is_symlink(self):return False
 def stat(self):return types.SimpleNamespace(st_uid=1000,st_mode=0o100400)
class AdapterTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.base=pathlib.Path(self.temp.name);self.root=self.base/'release';self.root.mkdir();(self.root/'bundle').mkdir();(self.root/'tooling').mkdir()
  self.config=self.base/'config';self.config.mkdir();(self.config/'ai-agent.yaml').write_text('providers: preserved\n')
  self.dbdir=self.base/'db';self.dbdir.mkdir();self.db=self.dbdir/'crm_v2.db'
  with sqlite3.connect(self.db) as db:db.executescript("CREATE TABLE instances(id INTEGER PRIMARY KEY,aiProvider TEXT);INSERT INTO instances VALUES(1,'neuro_gemini');")
  self.composefile=self.base/'original-compose.yaml';self.composefile.write_text('services: preserved\n')
  self.adcpath=self.base/'adc.json';self.adcpath.write_text('{"type":"fixture"}');self.adcpath.chmod(0o400)
  def row(role,name,image):
   return {'Name':'/'+name,'Id':role+'-original-id','Image':image,'Config':{'Env':['NEURO_GEMINI_ENABLED=true','EXISTING=preserved'],'Labels':{'com.docker.compose.project.config_files':str(self.composefile),'com.docker.compose.project.working_dir':str(self.base),'com.docker.compose.project':'fixture','com.docker.compose.service':role},'User':'1000:986','Entrypoint':None,'Cmd':['node','server.js'],'WorkingDir':'/app'},'HostConfig':{'RestartPolicy':{'Name':'unless-stopped'}},'State':{'Running':True,'Paused':False,'Health':{'Status':'healthy'}},'RestartCount':0,'NetworkSettings':{'Networks':{'fixture':{}}},'Mounts':[{'Type':'bind','Source':str(self.dbdir),'Destination':'/app/data','RW':True,'Propagation':'rprivate'}]}
  self.rows={'whatsapp_crm':row('crm','whatsapp_crm',I('a')),op.NAMES['worker']:row('worker',op.NAMES['worker'],I('b')),op.ENGINE:row('engine',op.ENGINE,I('c'))}
  self.rows[op.ENGINE]['Mounts']=[{'Type':'bind','Source':str(self.config),'Destination':'/app/config','RW':True,'Propagation':'rprivate'}]
  self.manifest={'baseCommit':op.BASE_COMMIT,'candidateCommit':'d'*40,'services':{'crm':{'baseImage':I('a')},'worker':{'baseImage':I('b')}}}
  (self.root/'bundle/manifest.json').write_text(json.dumps(self.manifest));(self.root/'images.json').write_text(json.dumps({'crm':I('d'),'worker':I('e')}))
  self.baselines={r:{'image':v['Image'],'environment':op.envmap(v),'volumes':[{'type':'bind','source':str(self.dbdir),'target':'/app/data','read_only':False,'bind':{'propagation':'rprivate'}}],'user':v['Config']['User']}for r,v in [('crm',self.rows['whatsapp_crm']),('worker',self.rows[op.NAMES['worker']])]}
  self.patches=[patch.object(op,'ADC',FakeADC(self.adcpath)),patch.object(op,'inspect',lambda n:copy.deepcopy(self.rows[n])),patch.object(op,'other_containers',lambda:{op.ENGINE:[self.rows[op.ENGINE]['Id'],I('c'),True,False,0]}),patch.object(op,'engine_ready',lambda:True),patch.object(op,'rendered',self.render)]
  for p in self.patches:p.start()
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  self.temp.cleanup()
 def render(self,row,override=None):
  role=row['Config']['Labels']['com.docker.compose.service']; value=copy.deepcopy(self.baselines[role])
  if override:
   block=json.loads(pathlib.Path(override).read_text())['services'][role]
   value['image']=block['image'];value['environment']={k:v.replace('$$','$')for k,v in block['environment'].items()}
   mounts={v['target']:v for v in value['volumes']}
   for v in block.get('volumes',[]):
    v=copy.deepcopy(v);v.setdefault('bind',{})['create_host_path']=True;mounts[v['target']]=v
   value['volumes']=list(mounts.values())
  return value
 def prepare(self):
  with contextlib.redirect_stdout(io.StringIO()):op.prepare(self.root)
  return op.load(self.root)
 def test_prepare_retains_engine_voice_selections_and_three_immutable_intents(self):
  p=self.prepare();self.assertNotIn('engine',p['before']);self.assertEqual(p['engineConfigHash'],op.sha(self.config/'ai-agent.yaml'))
  for role in op.NAMES:
   for key,enabled,admitted in [('intended','false','false'),('activationIntended','true','true'),('recoveryIntended','true','false')]:
    self.assertEqual(p[key][role]['environment'][op.FLAG],enabled);self.assertEqual(p[key][role]['environment'][op.ADMISSION],admitted)
    self.assertEqual(p[key][role]['environment']['NEURO_GEMINI_ENABLED'],'true')
  self.assertEqual(p['prepareBackup']['verifiedTables'],1)
 def test_prepare_rejects_existing_text_gemini_before_staging(self):
  with sqlite3.connect(self.db) as db:db.execute("UPDATE instances SET aiProvider='gemini'")
  with self.assertRaisesRegex(RuntimeError,'EXISTING_GEMINI_SELECTION'):self.prepare()
  self.assertFalse((self.root/'prepared.private.json').exists())
 def test_engine_config_drift_is_rejected(self):
  p=self.prepare();(self.config/'ai-agent.yaml').write_text('changed')
  with self.assertRaisesRegex(RuntimeError,'ENGINE_CONFIG_DRIFT'):op.guard_shared(p)
 def test_engine_environment_drift_is_rejected(self):
  p=self.prepare();self.rows[op.ENGINE]['Config']['Env'].append('CHANGED=1')
  with self.assertRaisesRegex(RuntimeError,'VOICE_ENGINE_RUNTIME_DRIFT'):op.guard_shared(p)
 def test_helper_sha_is_pinned(self):self.assertEqual(op.sha(op.CORE_PATH),op.CORE_HASH)
 def test_up_refuses_engine_recreation(self):
  p=self.prepare()
  with patch.object(op,'run') as run:
   with self.assertRaisesRegex(RuntimeError,'UNREVIEWED_SERVICE'):op.up(p,'engine','unused')
   run.assert_not_called()
 def test_up_checks_idle_before_targeted_recreation(self):
  p=self.prepare();events=[]
  def run(command,**kw):events.append(command);return ''
  def idle(p):events.append('ready')
  expected=p['intended']['crm'];row=copy.deepcopy(self.rows['whatsapp_crm']);row['Image']=p['images']['crm'];row['Config']['Env']=[k+'='+v for k,v in expected['environment'].items()];row['Mounts']=[{'Type':'bind','Source':v['source'],'Destination':v['target'],'RW':not v.get('read_only',False),'Propagation':'rprivate'}for v in expected['volumes']];self.rows['whatsapp_crm']=row
  with patch.object(op,'guard_shared'),patch.object(op,'text_restart_ready',idle),patch.object(op,'run',run),patch.object(op,'compose',return_value=(['docker','compose'],str(self.base),'crm')),patch.object(op.time,'sleep'):
   op.up(p,'crm',p['overrides']['crm'])
  self.assertEqual(events[0],'ready');self.assertEqual(events[1][-1],'crm');self.assertIn('--no-deps',events[1]);self.assertNotIn('engine',events[1])
 def test_rollback_refuses_after_activation_even_zero_gemini_rows(self):
  self.prepare();(self.root/'activation-started.private.json').write_text('{}')
  with patch.object(op,'up') as up:
   with self.assertRaisesRegex(RuntimeError,'COMPATIBILITY_RECOVERY'):op.rollback(self.root)
   up.assert_not_called()
 def test_rollback_only_selected_roles_allows_existing_voice_neuro(self):
  p=self.prepare();roles=[]
  with patch.object(op,'text_restart_ready'),patch.object(op,'up',side_effect=lambda p,r,*a,**kw:roles.append(r)),patch.object(op,'verify',return_value={'enginePreserved':True}),contextlib.redirect_stdout(io.StringIO()):op.rollback(self.root)
  self.assertEqual(roles,['worker','crm'])
 def test_failed_candidate_does_not_prevent_recovery(self):
  p=self.prepare();row=copy.deepcopy(self.rows['whatsapp_crm']);row['Image']=p['images']['crm'];row['State']['Running']=False;row['State']['Health']['Status']='unhealthy';row['RestartCount']=1;row['Config']['Env']=[k+'='+v for k,v in p['intended']['crm']['environment'].items()];row['Mounts']=[{'Type':'bind','Source':v['source'],'Destination':v['target'],'RW':not v.get('read_only',False),'Propagation':'rprivate'}for v in p['intended']['crm']['volumes']];self.rows['whatsapp_crm']=row
  with patch.object(op,'text_restart_ready'),patch.object(op,'up') as up,patch.object(op,'verify',return_value={}),contextlib.redirect_stdout(io.StringIO()):op.rollback(self.root)
  self.assertEqual(up.call_count,2)
 def test_recovery_keeps_compatible_runtime_and_closes_only_admission(self):
  p=self.prepare();roles=[]
  with patch.object(op,'up',side_effect=lambda p,r,path,**kw:roles.append((r,kw))),patch.object(op,'verify',return_value={'existingGeminiEnabled':True,'newSelectionEnabled':False}):receipt=op.close_admission(self.root,p)
  self.assertEqual([r for r,kw in roles],['worker','crm']);self.assertTrue(all(kw['recovery'] for r,kw in roles));self.assertTrue(receipt['existingGeminiEnabled'])
 def test_activation_failure_recovers_candidate_without_old_images(self):
  p=self.prepare();(self.root/'applied.private.json').write_text('{}');calls=[]
  def up(p,role,path,**kw):
   calls.append((role,kw))
   if kw.get('active') and role=='crm':raise RuntimeError('SERVICE_HEALTH_TIMEOUT')
  with patch.object(op,'text_restart_ready'),patch.object(op,'up',side_effect=up),patch.object(op,'verify',return_value={}):
   with self.assertRaisesRegex(RuntimeError,'ADMISSION_CLOSED_CANDIDATE_RETAINED'):op.activate(self.root)
  self.assertTrue((self.root/'activation-started.private.json').exists());self.assertTrue((self.root/'admission-recovered.private.json').exists());self.assertFalse((self.root/'activated.private.json').exists());self.assertTrue(all(not kw.get('rollback')for _,kw in calls))
 def test_reactivation_clears_recovery_marker(self):
  p=self.prepare()
  for name in ('applied.private.json','activation-started.private.json','admission-recovered.private.json','activated.private.json'):(self.root/name).write_text('{}')
  with patch.object(op,'text_restart_ready'),patch.object(op,'up'),patch.object(op,'verify',return_value={'newSelectionEnabled':True}),contextlib.redirect_stdout(io.StringIO()):op.activate(self.root)
  self.assertFalse((self.root/'admission-recovered.private.json').exists());self.assertTrue((self.root/'activated.private.json').exists())
 def test_apply_rejects_foreign_smoke_before_mutation(self):
  p=self.prepare();probe=self.root/'tooling/migration_probe.cjs';probe.write_text('fixture');gate={'pass':True,'sourceCommit':p['sourceCommit'],'candidateImage':p['images']['crm'],'oldImage':p['before']['crm']['Image'],'backupSHA256':p['prepareBackup']['sha256'],'probeSHA256':op.sha(probe)};(self.root/'migration-gate.json').write_text(json.dumps(gate));(self.root/'provider-smoke.json').write_text(json.dumps({'pass':True,'sourceCommit':'wrong','image':p['images']['crm']}))
  with patch.object(op,'migrate_live') as migrate,patch.object(op,'up') as up:
   with self.assertRaisesRegex(RuntimeError,'PROVIDER_SMOKE_MISSING'):op.apply(self.root)
   migrate.assert_not_called();up.assert_not_called()
 def test_live_migration_requires_text_columns_and_pinned_helper(self):
  p=self.prepare();probe=self.root/'tooling/migration_probe.cjs';probe.write_text('fixture');(self.root/'migration-gate.json').write_text(json.dumps({'probeSHA256':op.sha(probe)}))
  result={'ok':True,'mode':'apply','initVerified':True,'voiceColumnsVerified':True,'sourceReadableVerified':True,'exactDataFence':False}
  with patch.object(op,'run',return_value=json.dumps(result)):
   with self.assertRaisesRegex(RuntimeError,'LIVE_MIGRATION_FAILED'):op.migrate_live(self.root,p)
  result['textColumnsVerified']=True
  with patch.object(op,'run',return_value=json.dumps(result)):op.migrate_live(self.root,p)
  self.assertTrue((self.root/'migration-live.private.json').exists())
 def test_active_calls_are_allowed_without_any_asterisk_command(self):
  p=self.prepare();health={'status':'healthy','ari_connected':True,'audiosocket':{'listening':True},'providers':{'neuro_gemini':{'ready':True}},'active_calls':1,'active_sessions':1}
  with patch.object(op,'engine_ready',real_engine_ready),patch.object(op,'urlopen',return_value=io.StringIO(json.dumps(health))),patch.object(op,'run') as run:
   op.text_restart_ready(p)
   run.assert_not_called()
 def test_operator_hash_is_pinned_and_drift_stops_before_commands(self):
  p=self.prepare();self.assertEqual(p['operatorHash'],op.sha(op.OPERATOR_PATH));changed=self.base/'changed-operator.py';changed.write_text('changed')
  with patch.object(op,'OPERATOR_PATH',changed),patch.object(op,'run') as run:
   with self.assertRaisesRegex(RuntimeError,'OPERATOR_FILE_DRIFT'):op.text_restart_ready(p)
   run.assert_not_called()
 def test_prepared_record_without_operator_hash_is_rejected(self):
  p=self.prepare();p.pop('operatorHash')
  with self.assertRaisesRegex(RuntimeError,'OPERATOR_FILE_DRIFT'):op.text_restart_ready(p)
 def test_text_restart_requires_engine_readiness_before_up(self):
  p=self.prepare()
  with patch.object(op,'engine_ready',side_effect=RuntimeError('VOICE_ENGINE_NOT_READY')),patch.object(op,'run') as run:
   with self.assertRaisesRegex(RuntimeError,'VOICE_ENGINE_NOT_READY'):op.up(p,'crm',p['overrides']['crm'])
   run.assert_not_called()
class EnabledRuntimeTests(unittest.TestCase):
 setUp=AdapterTests.setUp
 tearDown=AdapterTests.tearDown
 render=AdapterTests.render
 prepare=AdapterTests.prepare
 def test_prepare_preserves_saved_gemini_runtime_and_pins_reviewed_base(self):
  for name in op.NAMES.values():self.rows[name]['Config']['Env'].append(op.FLAG+'=true')
  for value in self.baselines.values():value['environment'][op.FLAG]='true'
  self.manifest['baseCommit']='78fa4f5de4a34fc95e70ce2c8d6db637a5071b65'
  (self.root/'bundle/manifest.json').write_text(json.dumps(self.manifest))
  with sqlite3.connect(self.db) as db:db.execute("UPDATE instances SET aiProvider='gemini'")
  p=self.prepare();self.assertTrue(p['baseGeminiRuntime'])
  for role in op.NAMES:
   self.assertEqual(p['intended'][role]['environment'][op.FLAG],'true')
   self.assertEqual(p['intended'][role]['environment'][op.ADMISSION],'false')

if __name__=='__main__':unittest.main(verbosity=2)
