#!/usr/bin/env python3
"""Pinned CRM frontend, Onyx transport and knowledge preview; no other service/schema change."""
import sys
sys.dont_write_bytecode = True
import argparse, copy, fcntl, hashlib, importlib.util, io, json, os, posixpath, re, shutil, tarfile, tempfile, time
from pathlib import Path
from urllib.request import urlopen

HERE = Path(__file__).resolve()
COMMON = HERE.parent / 'common.py'
if not COMMON.exists(): COMMON = HERE.parent / 'customer-completion-release/common.py'
if hashlib.sha256(COMMON.read_bytes()).hexdigest() != 'b382ea400dd7490f40e9a8eb91ea17639d2aaaf714e871da2691edb6b6ceb58d':
    raise RuntimeError('REVIEWED_COMMON_DRIFT')
spec = importlib.util.spec_from_file_location('frontend_release_common', COMMON)
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
core = c.reviewed_core()
BASE = 'da3a2b1a1d456cc12a1a1345706b839046dfad01'
IMAGES = {'crm':'sha256:0cd3db5d4790dfc468792c16337d645c9ecebdd0d6501cb2253fadd0357d5cee',
 'worker':'sha256:a99a25c7f4348f270fe3a60b230501137312049230bcfe11c18b240c4e09f0ec',
 'engine':'sha256:e426aaa3b5d15ab23c356eb017262ecf83159cab1d308a2ac44bbf713eeecd0a',
 'admin':'sha256:ad00c820bdb419de026154b513e09e65ea83017960567c53f35b599c649599f3'}
NAMES = c.NAMES
require = c.require
EXTRAS = {'src/services/gemini-onyx.service.js':'M',
 'src/services/knowledge-preview-ai.service.js':'A',
 'src/routes/customer-knowledge-preview.routes.js':'M',
 'src/routes/customer-business-gpt.routes.js':'M'}
EXTRA_REPO = {'whatsapp_crm/'+name:status for name,status in EXTRAS.items()}
HOST_CONFIG_DRIFT_RECEIPT = None


def normalized_host_config(value):
    result=copy.deepcopy(value)
    binds=result.get('Binds')
    if binds is not None:
        require(isinstance(binds,list) and all(isinstance(item,str) for item in binds),'HOST_BINDS_INVALID')
        targets=[]
        for item in binds:
            parts=item.split(':');require(len(parts) in (2,3),'HOST_BIND_INVALID')
            target=parts[1]
            require(target.startswith('/') and posixpath.normpath(target)==target,'HOST_BIND_DESTINATION_INVALID')
            targets.append(target)
        require(len(targets)==len(set(targets)),'HOST_BIND_DESTINATION_COLLISION')
        result['Binds']=sorted(binds)  # Preserve the exact multiset; only order is irrelevant.
    return result


def unique_mount_destinations(mounts):
    targets=[item['Destination'] for item in mounts]
    require(len(targets)==len(set(targets)),'MOUNT_DESTINATION_COLLISION')


def frontend_only(repo, candidate):
    c.git(repo, 'merge-base', '--is-ancestor', BASE, candidate)
    tokens = c.git(repo, 'diff', '--no-renames', '--name-status', '-z', BASE, candidate).split(b'\0')
    require(tokens[-1] == b'' and len(tokens[:-1]) % 2 == 0, 'SOURCE_DIFF_INVALID')
    for index in range(0, len(tokens)-1, 2):
        status, name = tokens[index].decode(), tokens[index+1].decode(); c.relative(name)
        allowed = name.startswith(('whatsapp_crm/frontend/', 'whatsapp_crm/tests/', 'docs/', 'scripts/')) or name in EXTRA_REPO
        require(allowed and status in ('A','M','D'), 'NON_FRONTEND_CHANGE_REQUIRES_SEPARATE_RELEASE')
        if name in EXTRA_REPO:require(status == EXTRA_REPO[name], 'EXACT_RUNTIME_STATUS_REQUIRED')
    for name in ('whatsapp_crm/package.json','whatsapp_crm/package-lock.json',
                 'whatsapp_crm/frontend/package.json','whatsapp_crm/frontend/package-lock.json'):
        require(c.blob(repo, BASE, name) == c.blob(repo, candidate, name), 'BACKEND_DEPENDENCIES_CHANGED')


def pack(args):
    repo = args.repo.resolve(); candidate = c.commit(repo, args.candidate)
    frontend_only(repo, candidate)
    files = c.tree(args.frontend_dist); receipt = json.loads(args.frontend_receipt.read_text())
    c.validate_receipt(receipt, candidate, files)
    builder = 'scripts/customer-completion-release/build_frontend.py'
    require(receipt.get('builtFromFreshGitExport') is True and receipt.get('builderSha256') == c.sha(c.blob(repo,candidate,builder))
        and receipt.get('sourceTree') == c.git(repo,'rev-parse',candidate+':whatsapp_crm/frontend').decode().strip()
        and receipt.get('lockSha256') == c.sha(c.blob(repo,candidate,'whatsapp_crm/frontend/package-lock.json')), 'FRESH_FRONTEND_REQUIRED')
    code = c.blob(repo,candidate,'scripts/customer-completion-frontend-release.py')
    require(c.sha(code) == c.file_sha(HERE), 'UNCOMMITTED_OPERATOR')
    payload = {'frontend/dist/'+name:(args.frontend_dist/name).read_bytes() for name in files}
    preimages = {}
    for name,status in EXTRAS.items():
        payload[name] = c.blob(repo,candidate,'whatsapp_crm/'+name)
        previous = c.blob(repo,BASE,'whatsapp_crm/'+name,optional=True)
        require((previous is None) == (status == 'A'), 'EXACT_BASE_FILE_STATUS_REQUIRED')
        preimages[name] = c.sha(previous) if previous is not None else None
    tooling = {'tooling/customer-completion-frontend-release.py':code,
        'tooling/common.py':c.blob(repo,candidate,'scripts/customer-completion-release/common.py'),
        'neuro-gemini-release/release_operator.py':c.blob(repo,candidate,'scripts/neuro-gemini-release/release_operator.py')}
    require(c.sha(tooling['neuro-gemini-release/release_operator.py']) == c.CORE_HASH, 'REVIEWED_HELPER_DRIFT')
    manifest = {'kind':'customer-completion-crm-knowledge-preview','baseCommit':BASE,'candidateCommit':candidate,'baseImages':IMAGES,
        'files':{name:c.sha(data) for name,data in payload.items()},'receipt':receipt,
        'extraPreimages':preimages,
        'tooling':{name:c.sha(data) for name,data in tooling.items()}}
    entries = {**{'payload/'+name:data for name,data in payload.items()},**tooling,
        'manifest.json':c.canonical(manifest)+b'\n'}
    require(not args.output.exists(), 'OUTPUT_EXISTS')
    with tarfile.open(args.output,'w') as tar:
        for name,data in sorted(entries.items()):
            c.relative(name); info=tarfile.TarInfo(name); info.size=len(data);info.mode=0o644
            info.uid=info.gid=info.mtime=0;info.uname=info.gname='';tar.addfile(info,io.BytesIO(data))
    return {'phase':'packed','candidateCommit':candidate,'archiveSha256':c.file_sha(args.output),'manifestSha256':c.sha(entries['manifest.json'])}


class Release:
    def __init__(self,args):
        self.root=args.root.absolute();self.root.mkdir(mode=0o700,parents=True,exist_ok=True)
        require(not self.root.is_symlink(),'ROOT_SYMLINK');self.root.chmod(0o700);core.LOG_ROOT=self.root
        self.bundle=args.bundle.absolute();self.manifest_sha=args.manifest_sha256
        require(c.file_sha(self.bundle/'manifest.json')==self.manifest_sha,'MANIFEST_HASH_REQUIRED')
        self.m=json.loads((self.bundle/'manifest.json').read_text());self.bundle_guard()
    def run(self,command,**kwargs):return core.run(command,**kwargs)
    def inspect(self,name):return json.loads(self.run(['docker','inspect',name]))[0]
    def rows(self):return {role:self.inspect(name) for role,name in NAMES.items()}
    def bundle_guard(self):
        require(c.file_sha(self.bundle/'manifest.json')==self.manifest_sha,'MANIFEST_CHANGED')
        m=self.m;require(m['kind']=='customer-completion-crm-knowledge-preview' and m['baseCommit']==BASE and m['baseImages']==IMAGES,'MANIFEST_INVALID')
        require(re.fullmatch('[0-9a-f]{40}',m['candidateCommit']) and set(EXTRAS)<=set(m['files']) and 'frontend/dist/index.html' in m['files']
            and set(m.get('extraPreimages',{})) == set(EXTRAS),'MANIFEST_INVALID')
        for name,digest in m['files'].items():
            c.relative(name);require((name.startswith('frontend/dist/') or name in EXTRAS) and re.fullmatch('[0-9a-f]{64}',digest),'PAYLOAD_SCOPE_INVALID')
        for name,status in EXTRAS.items():
            previous=m['extraPreimages'][name]
            require(previous is None if status=='A' else isinstance(previous,str) and re.fullmatch('[0-9a-f]{64}',previous),'EXTRA_PREIMAGE_INVALID')
        require(c.tree(self.bundle/'payload')==m['files'],'PAYLOAD_CHANGED')
        for name,digest in m['tooling'].items():
            c.relative(name);require(c.file_sha(self.bundle/name)==digest,'TOOLING_CHANGED')
        require(m['tooling'].get('tooling/customer-completion-frontend-release.py')==c.file_sha(HERE)
            and m['tooling'].get('tooling/common.py')==c.file_sha(COMMON)
            and m['tooling'].get('neuro-gemini-release/release_operator.py')==c.CORE_HASH,'EXECUTING_TOOLING_DRIFT')
    def others(self):
        ids=self.run(['docker','ps','-aq']).split();rows=json.loads(self.run(['docker','inspect',*ids])) if ids else []
        return {r['Name']:[r['Id'],r['Image'],r['State']['Running'],r['State'].get('StartedAt'),r.get('RestartCount')]
            for r in rows if r['Name'].lstrip('/')!=NAMES['crm']}
    def inputs(self,rows):
        result={}
        for row in rows.values():
            labels=row['Config']['Labels']
            for key in ('com.docker.compose.project.config_files','com.docker.compose.project.environment_file'):
                for name in labels.get(key,'').split(','):
                    if name:require(Path(name).is_absolute() and Path(name).is_file(),'CONFIG_INPUT_MISSING');result[name]=c.file_sha(name)
        for mount in rows['crm']['Mounts']:
            if mount['RW'] and mount['Destination'] not in ('/app/config','/app/main.py','/app/scripts'):continue
            source=Path(mount['Source']);require(mount['Type']=='bind' and source.exists() and not source.is_symlink(),'CONFIG_BIND_INVALID')
            for path in [source] if source.is_file() else sorted(source.rglob('*')):
                require(not path.is_symlink() and (path.is_dir() or path.is_file()),'CONFIG_SPECIAL_FILE')
                if path.is_file():result[str(path)]=c.file_sha(path)
        return result
    def database(self,row):
        require(core.envmap(row).get('DB_PATH')=='/app/data/crm_v2.db','DATABASE_ENV_CHANGED')
        mounts=[x for x in row['Mounts'] if x['Destination']=='/app/data']
        require(len(mounts)==1 and mounts[0]['Type']=='bind' and mounts[0]['RW'],'DATABASE_MOUNT_CHANGED')
        file=Path(mounts[0]['Source'])/'crm_v2.db';require(file.is_file() and not file.is_symlink(),'DATABASE_INVALID');return file
    def metadata(self,file):
        stat=file.stat();parent=file.parent.stat()
        return {'identity':[stat.st_dev,stat.st_ino],'owner':[stat.st_uid,stat.st_gid,stat.st_mode&0o777],
            'directory':[parent.st_uid,parent.st_gid,parent.st_mode&0o777]}
    def db_guard(self,p):
        file=Path(p['database']);require(self.metadata(file)==p['databaseMetadata'],'DATABASE_METADATA_CHANGED')
        for suffix in ('-wal','-shm'):
            side=Path(str(file)+suffix)
            if side.exists():require(not side.is_symlink() and self.metadata(side)['owner']==p['databaseMetadata']['owner'],'DATABASE_SIDECAR_CHANGED')
    def backup(self,p):
        file=Path(p['database']);uid,gid,_=p['databaseMetadata']['owner'];directory=self.root/('backup-'+str(time.time_ns()))
        directory.mkdir(mode=0o700);os.chown(directory,uid,gid)
        script=r'''const fs=require('fs'),S=require('/app/node_modules/better-sqlite3');process.umask(0o077);
const timer=setTimeout(()=>process.exit(1),80000);const s=new S('/source/'+process.env.SOURCE_NAME,{readonly:true,fileMustExist:true});require('/app/node_modules/sqlite-vec').load(s);
s.backup('/backup/crm.db').then(()=>{s.close();const d=new S('/backup/crm.db');require('/app/node_modules/sqlite-vec').load(d);if(d.pragma('integrity_check',{simple:true})!=='ok')throw Error('INTEGRITY');d.pragma('journal_mode=DELETE');d.close();fs.chmodSync('/backup/crm.db',0o600);clearTimeout(timer);console.log('{"ok":true}');}).catch(()=>process.exit(1));'''
        out=self.run(['docker','run','--rm','--network','none','--read-only','--user',f'{uid}:{gid}',
            '--mount',f'type=bind,src={file.parent},dst=/source','--mount',f'type=bind,src={directory},dst=/backup',
            '-e','SOURCE_NAME='+file.name,'--entrypoint','node',IMAGES['crm'],'-e',script],timeout=100)
        require(json.loads(out).get('ok') is True,'BACKUP_FAILED');self.db_guard(p)
        return {'path':str(directory/'crm.db'),'sha256':c.file_sha(directory/'crm.db'),'integrityOk':True,'databaseRestored':False}
    def input_guard(self,p,recovery=False):
        self.bundle_guard();self.db_guard(p)
        require(all(c.file_sha(name)==digest for name,digest in p['inputs'].items()),'CONFIG_INPUT_DRIFT')
        require(self.inputs(p['before'])==p['inputs'],'CONFIG_TREE_DRIFT')
        if not recovery:require(self.others()==p['otherContainers'],'OTHER_CONTAINERS_CHANGED')
    def load(self):
        p=json.loads((self.root/'prepared.private.json').read_text())
        require(p['manifestSha256']==self.manifest_sha,'PREPARED_MANIFEST_DRIFT');return p
    def host_config_guard(self,before,after):
        global HOST_CONFIG_DRIFT_RECEIPT
        failure='HOST_CONFIG_CHANGED'
        try:
            if normalized_host_config(before)==normalized_host_config(after):return
        except RuntimeError as error:failure=str(error)
        changed=sorted(key for key in set(before)|set(after) if
            (sorted(before[key]) if key=='Binds' and isinstance(before.get(key),list) and all(isinstance(v,str) for v in before[key]) else before.get(key)) !=
            (sorted(after[key]) if key=='Binds' and isinstance(after.get(key),list) and all(isinstance(v,str) for v in after[key]) else after.get(key))
            or (key in before)!=(key in after))
        HOST_CONFIG_DRIFT_RECEIPT={'changedKeys':changed,'beforeSha256':c.sha(c.canonical(before)),'afterSha256':c.sha(c.canonical(after))}
        c.private_json(self.root/'host-config-drift.private.json',{'before':before,'after':after,**HOST_CONFIG_DRIFT_RECEIPT})
        raise RuntimeError(failure)
    def prepare(self):
        require(not (self.root/'prepared.private.json').exists(),'ALREADY_PREPARED')
        before=self.rows()
        for role,row in before.items():require(row['Image']==IMAGES[role] and row['State']['Running'],'BASE_IMAGE_STATE_CHANGED')
        others=self.others();inputs=self.inputs(before)
        row=before['crm'];excluded=c.excluded_mounts(row)
        normalized_host_config(row['HostConfig']);unique_mount_destinations(row['Mounts'])
        base=c.hashes(self.run,'crm',IMAGES['crm'],excluded,image=True)
        require(c.hashes(self.run,'crm',row['Id'],excluded)==base,'LIVE_IMAGE_SOURCE_DRIFT')
        for name,status in EXTRAS.items():
            expected = self.m['extraPreimages'][name]
            require((expected is None) == (status == 'A') and base.get(name)==expected, 'EXTRA_BASE_PREIMAGE_DRIFT')
        database=self.database(row);metadata=self.metadata(database)
        require(metadata['owner']==[1000,986,0o600],'DATABASE_OWNER_CHANGED')
        baseline=core.rendered(row)
        require(core.mount_signature(baseline.get('volumes',[]))==core.mount_signature(row['Mounts'],live=True),'COMPOSE_MOUNT_DRIFT')
        require(all(core.envmap(row).get(k)==v for k,v in baseline.get('environment',{}).items()),'COMPOSE_ENV_DRIFT')
        directory=self.root/'build';require(not directory.exists(),'BUILD_EXISTS');directory.mkdir()
        shutil.copytree(self.bundle/'payload/frontend/dist',directory/'dist')
        for name in EXTRAS:
            target=directory/'extra'/name;target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(self.bundle/'payload'/name,target);target.chmod(0o644)
        for target in (directory/'extra').rglob('*'):
            if target.is_dir():target.chmod(0o755)
        (directory/'extra').chmod(0o755)
        for path in [directory/'dist',*(directory/'dist').rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
        user=row['Config'].get('User');require(isinstance(user,str) and re.fullmatch('[A-Za-z0-9_:.-]+',user),'BASE_USER_INVALID')
        base_tag='ava-customer-frontend-base:'+IMAGES['crm'][-16:]
        self.run(['docker','tag',IMAGES['crm'],base_tag])
        (directory/'Dockerfile').write_text('FROM '+base_tag+'\nUSER 0:0\nRUN rm -rf /app/frontend/dist\nCOPY dist/ /app/frontend/dist/\nCOPY extra/ /app/\nUSER '+user+'\n')
        tag='ava-customer-frontend:'+self.m['candidateCommit'][:12]+'-'+self.manifest_sha[:10]
        self.run(['docker','build','--network','none','--pull=false','-t',tag,str(directory)],timeout=600)
        image=json.loads(self.run(['docker','image','inspect',tag]))[0]['Id']
        expected=c.expected_tree(base,self.m['files'],True)
        require(c.hashes(self.run,'crm',image,excluded,image=True)==expected,'UNSELECTED_SOURCE_BYTE_FENCE_FAILED')
        service=row['Config']['Labels']['com.docker.compose.service'];overrides={}
        for key,target in [('candidate',image),('rollback',IMAGES['crm'])]:
            override=self.root/(key+'.private.json');c.private_json(override,{'services':{service:{'image':target}}})
            wanted={**copy.deepcopy(baseline),'image':target}
            require(core.rendered(row,override)==wanted,'IMAGE_ONLY_COMPOSE_DRIFT');overrides[key]=str(override)
        p={'manifestSha256':self.manifest_sha,'candidateCommit':self.m['candidateCommit'],'before':before,'baseTree':base,
            'excluded':excluded,'expectedTree':expected,'image':image,'overrides':overrides,'baselineRender':baseline,
            'inputs':inputs,'otherContainers':others,'database':str(database),'databaseMetadata':metadata}
        self.input_guard(p);c.private_json(self.root/'prepared.private.json',p)
        return {'phase':'prepared','candidateCommit':p['candidateCommit'],'image':image,'liveContainersChanged':False}
    def guard_before(self,p):
        self.input_guard(p);row=self.inspect(NAMES['crm']);old=p['before']['crm']
        require(row['Id']==old['Id'] and row['Image']==IMAGES['crm'] and row['State']['Running'] and row.get('RestartCount')==old.get('RestartCount'),'CRM_CHANGED')
        require(core.envmap(row)==core.envmap(old) and row['Mounts']==old['Mounts'],'LIVE_RUNTIME_CHANGED')
        self.host_config_guard(old['HostConfig'],row['HostConfig'])
        require(c.hashes(self.run,'crm',row['Id'],p['excluded'])==p['baseTree'],'LIVE_SOURCE_CHANGED')
    def check(self,p,rollback=False):
        row=self.inspect(NAMES['crm']);old=p['before']['crm'];target=IMAGES['crm'] if rollback else p['image']
        require(row['Image']==target and row['State']['Running'] and not row['State'].get('Paused') and row.get('RestartCount')==0,'CRM_IMAGE_STATE_INVALID')
        require(core.envmap(row)==core.envmap(old),'ENV_CHANGED')
        unique_mount_destinations(row['Mounts']);unique_mount_destinations(old['Mounts'])
        require(core.mount_signature(row['Mounts'],live=True)==core.mount_signature(old['Mounts'],live=True),'MOUNTS_CHANGED')
        self.host_config_guard(old['HostConfig'],row['HostConfig'])
        require(set(row['NetworkSettings']['Networks'])==set(old['NetworkSettings']['Networks']),'NETWORK_CHANGED')
        for key in ('User','Entrypoint','Cmd','WorkingDir','Healthcheck','StopSignal','StopTimeout'):
            require(row['Config'].get(key)==old['Config'].get(key),'PROCESS_CHANGED:'+key)
        return row
    def up(self,p,rollback=False):
        self.input_guard(p,recovery=rollback);row=p['before']['crm'];target=IMAGES['crm'] if rollback else p['image']
        override=p['overrides']['rollback' if rollback else 'candidate'];require(core.rendered(row,override)=={**copy.deepcopy(p['baselineRender']),'image':target},'RENDER_CHANGED')
        command,cwd,service=core.compose(row,override)
        self.run(command+['up','-d','--no-deps','--pull','never','--force-recreate',service],cwd=cwd,timeout=120)
        until=time.monotonic()+90
        while time.monotonic()<until:
            current=self.inspect(NAMES['crm']);require(current.get('RestartCount')==0,'CRM_RESTARTED')
            if current['State'].get('Health',{}).get('Status')=='healthy':self.check(p,rollback);return
            time.sleep(2)
        raise RuntimeError('CRM_HEALTH_TIMEOUT')
    def verify(self,rollback=False):
        p=self.load();self.input_guard(p);row=self.check(p,rollback)
        wanted=p['baseTree'] if rollback else p['expectedTree']
        require(c.hashes(self.run,'crm',row['Id'],p['excluded'])==wanted,'RUNNING_SOURCE_FENCE_FAILED')
        require(row['State'].get('Health',{}).get('Status')=='healthy','CRM_UNHEALTHY')
        with urlopen('https://wh.meludtech.tech/api/health',timeout=15) as response:require(response.status==200 and json.load(response).get('status')=='ok','PUBLIC_API_FAILED')
        with urlopen('https://wh.meludtech.tech/',timeout=15) as response:require(response.status==200 and c.sha(response.read(2*1024*1024))==wanted['frontend/dist/index.html'],'PUBLIC_INDEX_CHANGED')
        return {'candidateCommit':p['candidateCommit'],'image':row['Image'],'rollback':rollback,'databaseRetained':True,'sourceBytesVerified':True,'otherContainersPreserved':True,'customerAcceptance':'NOT_TESTED'}
    def rollback(self):
        p=self.load();self.input_guard(p,recovery=True)
        try:current=self.inspect(NAMES['crm'])
        except Exception:current=None  # Failed recreate may leave no CRM container.
        if current:require(current['Image'] in (IMAGES['crm'],p['image']),'ROLLBACK_IMAGE_DRIFT')
        self.up(p,True);row=self.check(p,True);self.db_guard(p)
        require(c.hashes(self.run,'crm',row['Id'],p['excluded'])==p['baseTree'],'ROLLBACK_SOURCE_FENCE_FAILED')
        c.private_json(self.root/'rollback-crm-restored.private.json',{'image':row['Image'],'databaseRetained':True,'otherContainersPreserved':self.others()==p['otherContainers']})
        result=self.verify(True);c.private_json(self.root/'rolled-back.private.json',result);return result
    def apply(self):
        p=self.load();require(not (self.root/'apply-started.private.json').exists(),'APPLY_ALREADY_STARTED');self.guard_before(p)
        backup=self.backup(p);c.private_json(self.root/'backup.private.json',backup);self.guard_before(p);core.idle()
        c.private_json(self.root/'apply-started.private.json',{'candidateCommit':p['candidateCommit']})
        try:
            self.up(p);result=self.verify();c.private_json(self.root/'applied.private.json',result);return {'phase':'applied',**result,'backup':backup}
        except Exception as error:
            code = str(error)
            c.private_json(self.root/'activation-failure.private.json', {
                'code': code if re.fullmatch('[A-Z0-9_:.-]+', code) else 'ACTIVATION_CHECK_FAILED',
                'candidateCommit': p['candidateCommit'],
            })
            try:self.rollback()
            except Exception:raise RuntimeError('FRONTEND_APPLY_FAILED_CRM_ROLLBACK_REQUIRES_ATTENTION') from None
            raise RuntimeError('FRONTEND_APPLY_FAILED_PREVIOUS_CRM_RESTORED_DATABASE_RETAINED') from None


def main():
    os.umask(0o077);parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['pack','prepare','apply','verify','rollback'])
    for name in ('repo','frontend-dist','frontend-receipt','output','root','bundle'):parser.add_argument('--'+name,type=Path)
    parser.add_argument('--candidate');parser.add_argument('--manifest-sha256');args=parser.parse_args()
    if args.action=='pack':
        require(all(getattr(args,name) is not None for name in ['repo','candidate','frontend_dist','frontend_receipt','output']),'PACK_ARGUMENTS_REQUIRED');result=pack(args)
    else:
        require(args.root and args.bundle and args.manifest_sha256,'HOST_ARGUMENTS_REQUIRED')
        with Path('/var/lock/ava-customer-path-release.lock').open('a') as lock:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise RuntimeError('CROSS_SERVICE_RELEASE_ALREADY_RUNNING') from None
            result=getattr(Release(args),args.action)()
    print(json.dumps(result,sort_keys=True))

if __name__=='__main__':
    try:main()
    except Exception as error:
        value=str(error);result={'phase':'failed','code':value if re.fullmatch('[A-Z0-9_:.-]+',value) else 'FRONTEND_RELEASE_FAILED'}
        if HOST_CONFIG_DRIFT_RECEIPT is not None:result['hostConfigDrift']=HOST_CONFIG_DRIFT_RECEIPT
        print(json.dumps(result));raise SystemExit(1)
