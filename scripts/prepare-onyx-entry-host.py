"""Root operator preparation for the fixed Alleya isolated UI pilot only."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

BASE = Path('/opt/ava-deploy/onyx-customer-entry-1')
SOURCE = Path('/opt/ava-build/onyx-entry-runtime-20260918')

def command(args):
    return subprocess.check_output(args, text=True, timeout=30).strip()

def write(path, value, uid=0, gid=0):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.chown(path, uid, gid)

def main(phase):
    if os.geteuid() != 0:
        raise ValueError('ROOT_OPERATOR_REQUIRED')
    BASE.mkdir(mode=0o700, exist_ok=True)
    if BASE.is_symlink():
        raise ValueError('UNSAFE_PILOT_ROOT')
    if phase == 'capacity':
        values = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        total, available = (int(values[key].split()[0]) // 1024 for key in ('MemTotal', 'MemAvailable'))
        labels = command(['docker','ps','--filter','label=tech.melud.ava.deployment',
                          '--format','{{.Label "tech.melud.ava.deployment"}}'])
        data = {'totalMiB': total, 'availableMiB': available, 'observedAt': int(time.time()*1000),
                'runningDeploymentIds': sorted(set(labels.splitlines())) if labels else []}
        write(BASE / 'capacity.json', data, 1000, 1000)
        os.chown(BASE, 1000, 1000)
        print('PILOT_CAPACITY_PREPARED')
        return
    os.chown(BASE, 0, 0)
    for name in ('capacity.json', 'reservation.json'):
        path = BASE / name
        if path.is_symlink():
            raise ValueError('UNSAFE_OPERATOR_FILE')
        os.chown(path, 0, 0)
    reservation = json.loads((BASE/'reservation.json').read_text())
    row = reservation['row']
    if row['businessId'] != 1 or row['module'] != 'onyx' or row['state'] != 'reserved' or row['reservedMemoryMiB'] != 12800:
        raise ValueError('FIXED_PILOT_RESERVATION_REQUIRED')
    if row['hostname'] != 'alleya-resort-1.knowledge.meludtech.tech':
        raise ValueError('FIXED_PILOT_HOST_REQUIRED')
    if phase == 'launch':
        values = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        total, available = (int(values[key].split()[0]) // 1024 for key in ('MemTotal', 'MemAvailable'))
        if available - 12800 < total * .20:
            raise ValueError('PILOT_CAPACITY_REQUIRED')
        root = BASE / row['id']
        gateway = json.loads((root/'config/gateway.json').read_text())
        gateway['brokerOrigin'] = 'http://ava-onyx-entry-broker:3901'
        write(root/'config/gateway-pilot.json', gateway, 0, 1000)
        os.chmod(root/'config/gateway-pilot.json', 0o440)
        network = 'ava-onyx-entry-1-ingress'
        existing = subprocess.run(['docker','network','inspect',network], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        if not existing:
            command(['docker','network','create','--subnet','10.253.242.0/28',network])
        details = json.loads(command(['docker','network','inspect',network]))[0]
        if details['Internal'] or details['IPAM']['Config'][0]['Subnet'] != '10.253.242.0/28':
            raise ValueError('PILOT_INGRESS_CHANGED')
        override = {'services':{'gateway':{'ports':['127.0.0.1:3042:4080'],
            'volumes':[{'type':'bind','source':str(root/'config/gateway-pilot.json'),
                        'target':'/run/ava/gateway.json','read_only':True}]}},
            'networks':{'native':{'ipam':{'config':[{'subnet':'10.253.241.0/24'}]}},
                        'ingress':{'external':True,'name':network}}}
        write(root/'pilot-override.json', override)
        compose = ['docker','compose','--project-name',row['namespace'],'--project-directory',str(root),
                   '--env-file','/dev/null','-f',str(root/'compose.json'),'-f',str(root/'pilot-override.json')]
        command([*compose,'config','--quiet'])
        result = subprocess.run([*compose,'up','--detach','--no-build','--pull','never'], timeout=360,
                                stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
        (root/'launch.log').write_text(result.stdout)
        os.chmod(root/'launch.log',0o600)
        if result.returncode:
            raise ValueError('PILOT_START_FAILED')
        print(json.dumps({'deployment_id':row['id'],'started':True,'customer_ready':False}))
        return
    old = Path('/opt/ava-acceptance/ecosystem-20260914/onyx-recipe-qa-r13/catalogue.json')
    catalogue = json.loads(old.read_text())
    for key, tag in {
        'backendImage':'ava-onyx-api:customer-entry-20260918-r1',
        'webImage':'ava-onyx-web:customer-entry-20260918-r1',
        'gatewayImage':'ava-onyx-gateway:customer-entry-20260918-r1',
    }.items():
        catalogue[key] = command(['docker','image','inspect','--format','{{.Id}}',tag])
    catalogue['namespaceOverlayManifest']['backendImageDigest'] = catalogue['backendImage']
    for key, value in catalogue.items():
        if key.endswith('Image'):
            if command(['docker','image','inspect','--format','{{.Id}}',value]) != value.split('@')[-1]:
                raise ValueError('IMAGE_ID_CHANGED')
    write(BASE/'catalogue.json', catalogue)
    sys.path.insert(0, str(SOURCE/'scripts'))
    from onyx_recipe_factory import OnyxRecipeFactory
    OnyxRecipeFactory(BASE, BASE/'catalogue.json').prepare(row)
    manifest = {'schemaVersion':1,'kind':'ava_onyx_customer_entry_operator',
        'businessId':1,'deploymentId':row['id'],'nativeScope':row['namespace'],
        'revision':row['revision'],'principal':reservation['owner']}
    write(BASE/'operator.json', manifest)
    print(json.dumps({'deployment_id':row['id'],'recipe_prepared':True,'customer_ready':False}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', required=True, choices=['capacity','recipe','launch'])
    args = parser.parse_args()
    try:
        main(args.phase)
    except Exception:
        raise SystemExit('ONYX_ENTRY_HOST_PREPARATION_FAILED') from None
