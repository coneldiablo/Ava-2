import importlib.util,json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

def module(name,file):
    s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
resume=module('resume_4555','voice-recovery-resume.py');helper=module('release_for_resume_tests','voice-recovery-release.py')

class ResumeTests(unittest.TestCase):
    def fixture(self,directory):
        old=SimpleNamespace(SELECTED=helper.SELECTED,IMAGES=helper.IMAGES,NAMES=helper.NAMES,
            core=SimpleNamespace(idle=Mock()),c=SimpleNamespace(hashes=Mock(return_value={}),private_json=helper.c.private_json))
        images={role:'candidate-'+role for role in old.SELECTED};images['engine']=resume.ENGINE_IMAGE
        rows={role:{'Id':'stable-'+role,'Image':images[role] if role=='engine' else old.IMAGES[role],
            'RestartCount':0,'State':{'Running':True,'StartedAt':'stable-start'}} for role in old.SELECTED}
        r=SimpleNamespace(root=Path(directory),input_guard=Mock(),offline_guard=Mock(),check=Mock(),ready=Mock(),run=Mock(),
            crm_backup=Mock(return_value={'verified':True}),engine_backup=Mock(),runtime_guard=Mock())
        r.inspect=Mock(side_effect=lambda name:rows[next(role for role in old.SELECTED if old.NAMES[role]==name)])
        def activate(p,role,rollback=False):rows[role]['Image']=old.IMAGES[role] if rollback else p['images'][role];rows[role]['Id']='changed-'+role
        r.up=Mock(side_effect=activate);r.verify=Mock(return_value={'sourceBytesVerified':True,'databaseRetained':True,'images':images})
        p={'candidateCommit':resume.CANDIDATE,'images':images,'baseTrees':{role:{} for role in old.SELECTED},
            'expectedTrees':{role:{} for role in old.SELECTED},'excluded':{role:[] for role in old.SELECTED},'database':'/synthetic/crm.db','engineDatabases':[]}
        return r,p,old,rows,activate
    def test_verified_candidate_engine_is_never_recreated_while_worker_crm_finish(self):
        with tempfile.TemporaryDirectory() as d:
            r,p,old,rows,_=self.fixture(d);engine_before=resume.engine_identity(rows['engine']);result=resume.resume(r,p,old)
            self.assertEqual([c.args[1] for c in r.up.call_args_list],['worker','crm']);self.assertEqual(resume.engine_identity(rows['engine']),engine_before)
            self.assertTrue(result['engineProcessPreserved']);self.assertFalse(result['databaseRestored']);r.offline_guard.assert_called();r.crm_backup.assert_called_once()
            self.assertTrue((Path(d)/'resumed.private.json').is_file())
    def test_already_candidate_worker_is_verified_and_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            r,p,old,rows,_=self.fixture(d);rows['worker']['Image']=p['images']['worker'];resume.resume(r,p,old)
            self.assertEqual([c.args[1] for c in r.up.call_args_list],['crm'])
    def test_old_engine_refuses_before_any_backup_or_mutation(self):
        with tempfile.TemporaryDirectory() as d:
            r,p,old,rows,_=self.fixture(d);rows['engine']['Image']=old.IMAGES['engine']
            with self.assertRaisesRegex(RuntimeError,'VERIFIED_CANDIDATE_ENGINE_REQUIRED'):resume.resume(r,p,old)
            r.up.assert_not_called();r.crm_backup.assert_not_called()
    def test_unknown_worker_image_refuses_before_any_backup_or_mutation(self):
        with tempfile.TemporaryDirectory() as d:
            r,p,old,rows,_=self.fixture(d);rows['worker']['Image']='unreviewed-image'
            with self.assertRaisesRegex(RuntimeError,'RESUME_UNEXPECTED_IMAGE:worker'):resume.resume(r,p,old)
            r.up.assert_not_called();r.crm_backup.assert_not_called()
    def test_failed_worker_activation_recovers_only_touched_worker_and_keeps_engine(self):
        with tempfile.TemporaryDirectory() as d:
            r,p,old,rows,activate=self.fixture(d);engine_before=resume.engine_identity(rows['engine'])
            def failure(p,role,rollback=False):
                activate(p,role,rollback)
                if not rollback:raise RuntimeError('HEALTH_TIMEOUT:worker')
            r.up=Mock(side_effect=failure)
            with self.assertRaisesRegex(RuntimeError,'RESUME_FAILED_CRM_WORKER_RESTORED_ENGINE_PRESERVED'):resume.resume(r,p,old)
            self.assertEqual([c.args[1:] for c in r.up.call_args_list],[('worker',),('worker',True)])
            self.assertEqual(rows['worker']['Image'],old.IMAGES['worker']);self.assertEqual(resume.engine_identity(rows['engine']),engine_before)
            result=json.loads((Path(d)/'resume-recovery.private.json').read_text());self.assertTrue(result['engineProcessPreserved']);self.assertFalse(result['databaseRestored'])

if __name__=='__main__':unittest.main()
