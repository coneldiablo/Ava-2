#!/usr/bin/env python3
"""Finish the pinned 4555c9e CRM/worker activation; engine mutation is forbidden."""
import sys
sys.dont_write_bytecode=True
import argparse,fcntl,hashlib,importlib.util,json,re,time
from pathlib import Path
from urllib.error import URLError,HTTPError

HELPER_SHA='117d032fd55d408ec97b45922b77a50318ae60f1615f2e4b5afcc23b68195d2e'
CANDIDATE='4555c9e71f16bddd8cd598cec2fabd3230ade083'
ENGINE_IMAGE='sha256:60ce2614938ec3c1a05c6139e082581cd72e63e3b151e90444eabac643e34df6'
MUTABLE=('worker','crm')
def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def require(value,code):
    if not value:raise RuntimeError(code)
def safe(error):
    value=str(error)
    return {'code':value if re.fullmatch(r'[A-Z0-9_]+(?::(?:engine|worker|crm|admin))?',value) else 'RESUME_OPERATION_FAILED',
        'exceptionType':type(error).__name__}
def retryable(error):
    if isinstance(error,HTTPError):return error.code in (408,425,429,500,502,503,504)
    return isinstance(error,(URLError,TimeoutError,ConnectionError)) or isinstance(error,RuntimeError) and str(error) in ('ENGINE_NOT_READY','CRM_UNHEALTHY','COMMAND_FAILED')
def import_helper(bundle):
    path=bundle/'tooling/voice-recovery-release.py';require(digest(path)==HELPER_SHA,'BUNDLED_HELPER_SHA_CHANGED')
    spec=importlib.util.spec_from_file_location('pinned_4555c9e_release',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
def engine_identity(row):return [row['Id'],row['Image'],row['State'].get('StartedAt'),row.get('RestartCount')]

def runner_class(old):
    class ResumeRelease(old.Release):
        def ready(self,role):
            deadline=time.monotonic()+100
            while True:
                try:return super().ready(role)
                except Exception as error:
                    if not retryable(error):raise
                    old.c.private_json(self.root/('resume-'+role+'-readiness.private.json'),safe(error))
                    if time.monotonic()>=deadline:raise RuntimeError('RESUME_READINESS_TIMEOUT:'+role) from None
                    time.sleep(2)
        def up(self,p,role,rollback=False):
            require(role in MUTABLE,'ENGINE_MUTATION_FORBIDDEN')
            return super().up(p,role,rollback)
    return ResumeRelease

def validate_current(r,p,old,engine_before=None):
    r.input_guard(p);r.offline_guard(p);rows={}
    for role in old.SELECTED:
        row=r.inspect(old.NAMES[role]);rows[role]=row
        require(row['Image'] in (old.IMAGES[role],p['images'][role]),'RESUME_UNEXPECTED_IMAGE:'+role)
        baseline=row['Image']==old.IMAGES[role]
        r.check(p,role,baseline)
        expected=p['baseTrees'][role] if baseline else p['expectedTrees'][role]
        require(old.c.hashes(r.run,role,row['Id'],p['excluded'][role])==expected,'RESUME_SOURCE_DRIFT:'+role)
    require(rows['engine']['Image']==ENGINE_IMAGE and p['images']['engine']==ENGINE_IMAGE,'VERIFIED_CANDIDATE_ENGINE_REQUIRED')
    if engine_before is not None:require(engine_identity(rows['engine'])==engine_before,'ENGINE_PROCESS_CHANGED')
    r.ready('engine')
    return rows

def resume(r,p,old):
    require(p['candidateCommit']==CANDIDATE,'EXACT_PREPARED_CANDIDATE_REQUIRED')
    require(not (r.root/'resume-started.private.json').exists(),'RESUME_ALREADY_STARTED')
    rows=validate_current(r,p,old);engine_before=engine_identity(rows['engine'])
    old.core.idle()
    suffix=str(time.time_ns())
    backups={'crm':r.crm_backup(Path(p['database']),'resume-crm-backup-'+suffix,old.IMAGES['crm']),
        'engine':{str(i):r.engine_backup(Path(path),'resume-engine-backup-'+suffix+'-'+str(i),ENGINE_IMAGE) for i,path in enumerate(p['engineDatabases'])},'databaseRestored':False}
    old.c.private_json(r.root/'resume-backups.private.json',backups)
    validate_current(r,p,old,engine_before);old.core.idle()
    old.c.private_json(r.root/'resume-started.private.json',{'candidateCommit':CANDIDATE,'engineIdentity':engine_before})
    touched=[]
    try:
        for role in MUTABLE:
            current=validate_current(r,p,old,engine_before)
            if current[role]['Image']==p['images'][role]:r.ready(role);continue
            touched.append(role);r.up(p,role)
        validate_current(r,p,old,engine_before)
        result=r.verify();require(result.get('sourceBytesVerified') is True and result.get('databaseRetained') is True,'RESUME_VERIFY_FAILED')
        require(engine_identity(r.inspect(old.NAMES['engine']))==engine_before,'ENGINE_PROCESS_CHANGED')
        receipt={'phase':'resumed',**result,'engineProcessPreserved':True,'engineRestarted':False,'databaseRestored':False}
        old.c.private_json(r.root/'resumed.private.json',receipt);return receipt
    except Exception as error:
        old.c.private_json(r.root/'resume-failure.private.json',safe(error));failures={}
        # Restore only the CRM/worker roles this attempt changed. Never call the
        # old all-service rollback/recover, and never restore a database.
        for role in reversed(touched):
            try:
                row=r.inspect(old.NAMES[role]);require(row['Image'] in (old.IMAGES[role],p['images'][role]),'RESUME_RECOVERY_IMAGE_DRIFT:'+role)
                r.runtime_guard(p,role,row,row['Image']==old.IMAGES[role]);r.up(p,role,True);r.check(p,role,True)
            except Exception as recovery:failures[role]=safe(recovery)
        preserved=engine_identity(r.inspect(old.NAMES['engine']))==engine_before
        old.c.private_json(r.root/'resume-recovery.private.json',{'failures':failures,'engineProcessPreserved':preserved,'databaseRestored':False})
        require(not failures and preserved,'RESUME_FAILED_RECOVERY_REQUIRES_ATTENTION')
        raise RuntimeError('RESUME_FAILED_CRM_WORKER_RESTORED_ENGINE_PRESERVED') from None

def main():
    import os
    os.umask(0o077);p=argparse.ArgumentParser(description=__doc__)
    for name in ('root','bundle'):p.add_argument('--'+name,type=Path,required=True)
    for name in ('manifest-sha256','prepared-sha256','utility-sha256'):p.add_argument('--'+name,required=True)
    args=p.parse_args();require(digest(Path(__file__))==args.utility_sha256,'RESUME_UTILITY_SHA_CHANGED')
    require(digest(args.root/'prepared.private.json')==args.prepared_sha256,'PREPARED_STATE_SHA_CHANGED')
    with Path('/var/lock/ava-customer-path-release.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('CROSS_SERVICE_RELEASE_ALREADY_RUNNING') from None
        old=import_helper(args.bundle.absolute());r=runner_class(old)(args);p=r.load()
        print(json.dumps(resume(r,p,old),sort_keys=True))
if __name__=='__main__':
    try:main()
    except Exception as error:print(json.dumps({'phase':'failed',**safe(error)}));raise SystemExit(1)
