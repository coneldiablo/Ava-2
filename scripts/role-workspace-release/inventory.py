#!/usr/bin/env python3
"""Read-only Docker inventory; output contains hashes and public runtime facts."""
import argparse
import json
from pathlib import Path
import re
import subprocess


def call(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError('INVENTORY_COMMAND_FAILED')
    return result.stdout


def validate_paths(paths):
    if not isinstance(paths, list) or not paths or any(not isinstance(p, str) or
            not re.fullmatch(r'(?:src/[a-zA-Z0-9_./-]+\.js|server\.js|provisioning-worker\.js|instagram_private/server\.js)', p) or
            '..' in p.split('/') for p in paths):
        raise RuntimeError('INVENTORY_PATHS_INVALID')


def inventory(paths):
    validate_paths(paths)
    result = {}
    script = r'''const fs=require('fs'),path=require('path'),c=require('crypto'),names=JSON.parse(process.argv[1]),out={};
const hash=p=>c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
out.sourceHashes=Object.fromEntries(names.map(n=>[n,fs.existsSync('/app/'+n)?hash('/app/'+n):null]));
out.frontendFiles={};function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){
const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.isFile())out.frontendFiles[path.relative('/app/frontend/dist',p)]=hash(p);else throw Error('FRONTEND_SPECIAL_FILE');}}
if(fs.existsSync('/app/frontend/dist'))walk('/app/frontend/dist');console.log(JSON.stringify(out));'''
    for service in ('whatsapp_crm', 'provisioning_worker'):
        ids = call(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.service=' + service]).split()
        if len(ids) != 1:
            raise RuntimeError('INVENTORY_SERVICE_AMBIGUOUS')
        row = json.loads(call(['docker', 'inspect', ids[0]]))[0]
        hashes = json.loads(call(['docker', 'exec', row['Id'], 'node', '-e', script, json.dumps(paths)]))
        result[service] = {'container': row['Name'], 'image': row['Image'], 'user': row['Config'].get('User'),
            'entrypoint': row['Config'].get('Entrypoint'), 'cmd': row['Config'].get('Cmd'), **hashes}
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--paths-json', type=Path)
    group.add_argument('--engine', action='store_true')
    args = parser.parse_args()
    if args.engine:
        row = json.loads(call(['docker', 'inspect', 'ai_engine']))[0]
        script = 'import pathlib,hashlib,json; print(json.dumps({str(p.relative_to("/app")):hashlib.sha256(p.read_bytes()).hexdigest() for p in pathlib.Path("/app/src").rglob("*.py")}))'
        value = {'container': row['Name'], 'image': row['Image'],
                 'sourceHashes': json.loads(call(['docker', 'exec', 'ai_engine', 'python', '-c', script]))}
    else:
        value = inventory(json.loads(args.paths_json.read_text()))
    print(json.dumps(value, sort_keys=True, indent=2))
