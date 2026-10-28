#!/usr/bin/env python3
"""Attest already installed images for the disposable Onyx recipe only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re

import module_deployment_helper as helper
from onyx_recipe_factory import catalogue

BASE = Path('/opt/ava-acceptance/ecosystem-20260914')
SOURCE = Path(__file__).resolve().parents[1]
PINNED_IMAGES = {
    'backendImage': 'sha256:ff0496c9b3a92e603ea223d9bbe6dbe420e4313e13284105a73560557f546295',
    'webImage': 'sha256:30d0adaa0fa036efe0dcf3be312bc28212c65d6dcbb1d77dcddea168d08a1f82',
    'modelImage': 'sha256:2e1eecb40c47814713afb2a10b0d3217dd6d47db22f7083738283e9d6f089f61',
    'postgresImage': 'sha256:d9c304353c031b21e9a7e33dc4781e272a9fa802a2ab9703fe4199d72ba1422c',
    'redisImage': 'sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf',
    'searchImage': 'sha256:b5dd1512af2a99748c942cfbbd7f32162623336b210667d0fc6333c6321f171d',
    'gatewayImage': 'sha256:b94f9697736cec450f5ee91bfb0a6d367caac616097e32e567eba7c46dc8e0a8',
}
CACHE_SHA256 = '7a3761c7d41f5c0c4aecae03b6efc1117f6309093ab005487629384af34fec89'


def installed(image, expected_user=None, revision=None):
    if not helper.DIGEST.fullmatch(image): raise ValueError('QA_IMAGE_DIGEST_REQUIRED')
    rows = json.loads(helper.run(['docker', 'image', 'inspect', image], timeout=15))
    if len(rows) != 1 or rows[0].get('Id') != image: raise ValueError('QA_IMAGE_NOT_INSTALLED')
    config = rows[0].get('Config', {})
    if expected_user is not None and str(config.get('User', '')) != expected_user:
        raise ValueError('QA_IMAGE_USER_INVALID')
    if revision and config.get('Labels', {}).get('org.opencontainers.image.revision') != revision:
        raise ValueError('QA_IMAGE_SOURCE_INVALID')


def prepare(directory, blob_image, client_image):
    if os.geteuid() != 0 or directory.parent != BASE or not re.fullmatch(r'onyx-recipe-qa-[a-z0-9-]+', directory.name):
        raise ValueError('QA_DIRECTORY_REQUIRED')
    helper.owned_path(directory, directory=True)
    if directory.stat().st_mode & 0o777 != 0o700 or any(directory.iterdir()):
        raise ValueError('QA_EMPTY_PRIVATE_DIRECTORY_REQUIRED')
    images = {**PINNED_IMAGES, 'blobImage': blob_image, 'blobClientImage': client_image}
    for image in images.values(): installed(image)
    installed(images['gatewayImage'], 'node')
    installed(blob_image, '1001:1001', '9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a')
    installed(client_image, '0:0', '7394ce0dd2a80935aded936b09fa12cbb3cb8096')
    cache_file = BASE / 'onyx-full-build-r1/model-cache-manifest.json'
    helper.owned_path(cache_file)
    raw = cache_file.read_bytes()
    if hashlib.sha256(raw).hexdigest() != CACHE_SHA256:
        raise ValueError('QA_MODEL_CACHE_ATTESTATION_CHANGED')
    cache = json.loads(raw)
    # Read the embedded source manifest and compare every named output against
    # the actual immutable image. No environment or application data is read.
    inspect = """from pathlib import Path
import hashlib,json,os,stat
r=Path('/app');m=json.loads((r/'AVA_EXTENSION_MANIFEST.json').read_text())
if m['upstream_commit']!='a1b9e02eb65cc114c65381cbef5e555e1753ed0a' or m['commercial_files_modified'] is not False:
 raise ValueError('QA_NAMESPACE_SOURCE_INVALID')
if set(m['changes'])!={'onyx/configs/app_configs.py','onyx/document_index/opensearch/client.py','onyx/ava_namespace.py'}:
 raise ValueError('QA_NAMESPACE_FILES_INVALID')
if not all(hashlib.sha256((r/p).read_bytes()).hexdigest()==h for p,h in m['changes'].items()):
 raise ValueError('QA_NAMESPACE_CONTENT_INVALID')
if os.getuid()!=1001 or os.environ.get('AVA_NATIVE_HTTP_GUARD')!='true' or os.environ.get('HF_HUB_OFFLINE')!='1':
 raise ValueError('QA_BACKEND_RUNTIME_POLICY_INVALID')
core_file=r/'onyx/ava_auth/core.py'
if not core_file.is_file() or core_file.is_symlink():
 raise ValueError('QA_AUTH_CORE_INVALID')
core_hash=hashlib.sha256(core_file.read_bytes()).hexdigest()
app_file=r/'onyx/ava_auth/app.py'
if not app_file.is_file() or app_file.is_symlink():
 raise ValueError('QA_AUTH_APP_INVALID')
app_hash=hashlib.sha256(app_file.read_bytes()).hexdigest()
state_dir=Path('/var/lib/ava-auth')
if not state_dir.is_dir() or state_dir.is_symlink():
 raise ValueError('QA_STATE_DIRECTORY_INVALID')
st=state_dir.stat()
if st.st_uid!=1001 or st.st_gid!=1001 or (st.st_mode & 0o777)!=0o700:
 raise ValueError('QA_STATE_DIRECTORY_PERMISSIONS_INVALID')
from tokenizers import Tokenizer
token_count=len(Tokenizer.from_pretrained('nomic-ai/nomic-embed-text-v1').encode('AVA offline tokenizer verification').ids)
if token_count<1: raise ValueError('QA_BACKEND_TOKENIZER_INVALID')
print(json.dumps({'namespace':m['changes']['onyx/ava_namespace.py'],'core_hash':core_hash,'app_hash':app_hash,'state_dir_valid':True,'tokenizer_loaded_offline':True,'token_count':token_count}))
"""
    proof = json.loads(helper.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--memory', '256m',
                                 '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', 'python',
                                 images['backendImage'], '-c', inspect], timeout=30))
    hashes = {
        'ava_namespace.py': hashlib.sha256((SOURCE / 'native_modules/onyx/ava_namespace.py').read_bytes()).hexdigest(),
        'install_namespace.py': hashlib.sha256((SOURCE / 'native_modules/onyx/install_namespace.py').read_bytes()).hexdigest(),
        'core.py': hashlib.sha256((SOURCE / 'native_modules/onyx/auth/core.py').read_bytes()).hexdigest(),
        'app.py': hashlib.sha256((SOURCE / 'native_modules/onyx/auth/app.py').read_bytes()).hexdigest(),
    }
    if proof.get('namespace') != hashes['ava_namespace.py']:
        raise ValueError('QA_NAMESPACE_SOURCE_MISMATCH')
    if proof.get('core_hash') != hashes['core.py']:
        raise ValueError('QA_AUTH_CORE_SOURCE_MISMATCH')
    if proof.get('app_hash') != hashes['app.py']:
        raise ValueError('QA_AUTH_APP_SOURCE_MISMATCH')
    if proof.get('state_dir_valid') is not True:
        raise ValueError('QA_STATE_DIRECTORY_INVALID')
    if proof.get('tokenizer_loaded_offline') is not True or type(proof.get('token_count')) is not int or proof['token_count'] < 1:
        raise ValueError('QA_BACKEND_TOKENIZER_INVALID')
    value = {'schemaVersion': 1, 'sourceCommit': helper.PINNED['onyx'], **images,
             'backendUid':1001, 'backendGid':1001, 'webUid':1000, 'webGid':1000,
             'modelUid':1001, 'modelGid':1001, 'postgresUid':70, 'postgresGid':70,
             'redisUid':999, 'redisGid':1000, 'searchUid':1000, 'searchGid':1000,
             'blobUid':1001, 'blobGid':1001, 'modelCacheManifest':cache,
             'namespaceOverlayManifest': {'schemaVersion':1, 'sourceCommit':helper.PINNED['onyx'],
                 'backendImageDigest':images['backendImage'],
                 'files': {'ava_namespace.py': hashes['ava_namespace.py'], 'install_namespace.py': hashes['install_namespace.py']}}}
    catalogue(value)
    data = json.dumps(value, sort_keys=True, separators=(',', ':')).encode() + b'\n'
    fd = os.open(directory / 'catalogue.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output: output.write(data); output.flush(); os.fsync(output.fileno())
    return {'qa_only':True, 'buyer_acceptance':False, 'catalogue_sha256':hashlib.sha256(data).hexdigest(),
            'model_files':len(cache['files']), 'backend_tokenizer_loaded_offline':True, 'images':images}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--blob-image', required=True)
    parser.add_argument('--client-image', required=True)
    args = parser.parse_args()
    try: print(json.dumps(prepare(args.directory, args.blob_image, args.client_image)))
    except Exception:
        raise SystemExit('ONYX_QA_CATALOGUE_PREPARATION_FAILED') from None
