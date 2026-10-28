#!/usr/bin/env python3
"""Build two CRM overlays on exact production images; leave all live services alone."""
import argparse,hashlib,importlib.util,json,os,subprocess
from pathlib import Path
spec=importlib.util.spec_from_file_location('archive',Path(__file__).with_name('archive.py'))
archive=importlib.util.module_from_spec(spec);spec.loader.exec_module(archive)
def require(ok,code):
    if not ok: raise RuntimeError(code)
def call(command,timeout=60):
    r=subprocess.run(command,capture_output=True,text=True,timeout=timeout)
    require(r.returncode==0,'ISOLATED_IMAGE_CHECK_FAILED')
    return r.stdout
def hashes(image,names,user=None):
    code='const fs=require("fs"),c=require("crypto"),out={};for(const n of JSON.parse(fs.readFileSync(0,"utf8"))){const p="/app/"+n;out[n]=fs.existsSync(p)?c.createHash("sha256").update(fs.readFileSync(p)).digest("hex"):null;}console.log(JSON.stringify(out))'
    command=['docker','run','--rm','-i','--network','none']+(['--user',user] if user else [])+['--entrypoint','node',image,'-e',code]
    r=subprocess.run(command,input=json.dumps(list(names)),capture_output=True,text=True,timeout=60)
    require(r.returncode==0,'IMAGE_SOURCE_UNREADABLE');return json.loads(r.stdout)
def main(root):
    os.umask(0o077);context=root/'bundle';require(not context.exists(),'BUNDLE_ALREADY_EXISTS')
    archive.unpack(root/'bundle.tar.gz',context)
    manifest=json.loads((context/'manifest.json').read_text());images={}
    for role in ('crm','worker'):
        block=manifest['services'][role];directory=context/role
        require(hashes(block['baseImage'],block['baseFiles'])==block['baseFiles'],'BASE_SOURCE_DRIFT')
        for name,expected in block['files'].items():
            relative='frontend/'+name.removeprefix('frontend/dist/') if role=='crm' and name.startswith('frontend/dist/') else 'deps/'+name.removeprefix('ava-gemini-deps/') if name.startswith('ava-gemini-deps/') else 'payload/'+name
            path=directory/relative
            require(hashlib.sha256(path.read_bytes()).hexdigest()==expected,'PAYLOAD_DRIFT')
        for p in directory.rglob('*'):
            require(not p.is_symlink(),'CONTEXT_SYMLINK');p.chmod(0o755 if p.is_dir() else 0o644)
        directory.chmod(0o755)
        call(['docker','tag',block['baseImage'],block['baseTag']])
        require(json.loads(call(['docker','image','inspect',block['baseTag']]))[0]['Id']==block['baseImage'],'BASE_TAG_DRIFT')
        with (root/(role+'-build.private.log')).open('w') as log:
            r=subprocess.run(['docker','build','--pull=false','--network','host','--iidfile',str(root/(role+'.image')),'-t','ava-gemini-text-'+role+':'+manifest['candidateCommit'][:12],str(directory)],stdout=log,stderr=subprocess.STDOUT,timeout=300)
        require(r.returncode==0,'IMAGE_BUILD_FAILED_'+role.upper())
        image=(root/(role+'.image')).read_text().strip();base=json.loads(call(['docker','image','inspect',block['baseImage']]))[0];row=json.loads(call(['docker','image','inspect',image]))[0]
        require(row['RootFS']['Layers'][:len(base['RootFS']['Layers'])]==base['RootFS']['Layers'],'BASE_LAYERS_CHANGED')
        require(hashes(image,block['files'])==block['files'],'CANDIDATE_SOURCE_DRIFT')
        require(hashes(image,block['files'],'1000:986')==block['files'],'APP_UID_SOURCE_UNREADABLE')
        version=call(['docker','run','--rm','--network','none','--user','1000:986','--entrypoint','node',image,'-e','console.log(require("google-auth-library/package.json").version);require("/app/src/services/gemini-text.service");require("/app/src/services/gemini-embeddings.service")']).strip().splitlines()[0]
        require(version=='10.5.0','GOOGLE_AUTH_DEPENDENCY_INVALID')
        images[role]=image
        print(json.dumps({'phase':'image_verified','role':role,'image':image,'selectedFiles':len(block['files']),'baseLayersPreserved':True,'googleAuthVersion':version}),flush=True)
    (root/'images.json').write_text(json.dumps(images,indent=2)+'\n')
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,required=True);main(parser.parse_args().root)
