#!/usr/bin/env python3
"""Explicit, reversible installation of additive external SIP host support."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import time


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def write(path, content, mode=None, uid=None, gid=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('.' + path.name + '.external-install')
    if temporary.exists() or temporary.is_symlink() or path.is_symlink():
        raise RuntimeError('unsafe_path')
    previous = path.stat() if path.exists() else None
    mode = (previous.st_mode & 0o777 if previous else 0o600) if mode is None else mode
    uid = (previous.st_uid if previous else os.geteuid()) if uid is None else uid
    gid = (previous.st_gid if previous else os.getegid()) if gid is None else gid
    with temporary.open('xb') as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(mode)
    os.chown(temporary, uid, gid)
    os.replace(temporary, path)
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=20).stdout


def drained(asterisk):
    if any('!' in line for line in run(asterisk, '-rx', 'core show channels concise').splitlines()):
        raise RuntimeError('active_calls_do_not_install')


def install(options):
    if os.geteuid() != 0:
        raise RuntimeError('root_required')
    target = Path(options.agent_target)
    if digest(target) != options.expected_agent_sha or target.is_symlink():
        raise RuntimeError('host_agent_changed_review_before_install')
    includes = [(Path(options.pjsip_include), '#tryinclude ' + options.directory + '/pjsip/*.conf'),
                (Path(options.dialplan_include), '#tryinclude ' + options.directory + '/dialplan/*.conf')]
    for path, line in includes:
        if not path.is_file() or path.is_symlink() or line in path.read_text():
            raise RuntimeError('include_missing_or_already_installed')
    root = Path(options.directory)
    if root.exists() or root.is_symlink():
        raise RuntimeError('external_directory_exists')
    protocols = json.loads(options.transports)
    if not isinstance(protocols, dict) or not protocols or any(protocol not in ('udp', 'tcp', 'tls') for protocol in protocols):
        raise RuntimeError('transports_invalid')
    import external_sip
    os.environ['AVA_TELEPHONY_EXTERNAL_TRANSPORTS'] = json.dumps(protocols)
    if external_sip.transports(lambda command: run(options.asterisk, '-rx', command)) != protocols:
        raise RuntimeError('transport_not_loaded_or_tls_not_verified')
    dropin = Path('/etc/systemd/system/ava-telephony-agent.service.d/50-external-sip.conf')
    environment = Path('/etc/ava/external-sip.env')
    helper = target.with_name('external_sip.py')
    if any(path.exists() or path.is_symlink() for path in (dropin, environment, helper)):
        raise RuntimeError('owned_install_files_already_exist')
    drained(options.asterisk)
    backup = Path(options.backups) / ('external-sip-' + str(time.time_ns()))
    backup.mkdir(mode=0o700, parents=True)
    changes = []
    def put(path, content, mode=0o600):
        old = path.read_bytes() if path.exists() else None
        stat = path.stat() if old is not None else None
        index = len(changes)
        if old is not None:
            write(backup / str(index), old, path.stat().st_mode & 0o777)
        # Journal the intended replacement before writing it. A stopped install
        # can therefore reconcile both "not written" and "written, ACK lost".
        changes.append({'path': str(path), 'before': index if old is not None else None,
                        'beforeHash': hashlib.sha256(old).hexdigest() if old is not None else None,
                        'after': hashlib.sha256(content).hexdigest(), 'mode': mode,
                        'beforeMode': stat.st_mode & 0o777 if stat else None, 'beforeUid': stat.st_uid if stat else None, 'beforeGid': stat.st_gid if stat else None})
        write(backup / 'manifest.json', json.dumps({'directory': str(root), 'changes': changes}, indent=2).encode())
        write(path, content, mode)
    account = pwd.getpwnam('asterisk')
    for path in (root, root / 'pjsip', root / 'dialplan'):
        path.mkdir(mode=0o700)
        os.chown(path, account.pw_uid, account.pw_gid)
    put(root / 'install.json', b'{"version":1}', 0o640)
    os.chown(root / 'install.json', 0, account.pw_gid)
    for path, line in includes:
        put(path, path.read_bytes().rstrip() + ('\n\n' + line + '\n').encode(), path.stat().st_mode & 0o777)
    put(target, Path(__file__).with_name('agent.py').read_bytes(), target.stat().st_mode & 0o777)
    put(helper, Path(__file__).with_name('external_sip.py').read_bytes(), 0o644)
    put(environment, ('AVA_TELEPHONY_EXTERNAL_SIP_ENABLED=true\nAVA_TELEPHONY_EXTERNAL_DIR=' + str(root) + "\nAVA_TELEPHONY_EXTERNAL_TRANSPORTS='" + json.dumps(protocols, separators=(',', ':')) + "'\n").encode())
    put(dropin, ('[Service]\nEnvironmentFile=/etc/ava/external-sip.env\nReadWritePaths=' + str(root) + '\n').encode(), 0o644)
    drained(options.asterisk)
    run(options.asterisk, '-rx', 'pjsip reload')
    run(options.asterisk, '-rx', 'dialplan reload')
    run('/bin/systemctl', 'daemon-reload')
    run('/bin/systemctl', 'restart', 'ava-telephony-agent.service')
    print(json.dumps({'installed': True, 'backup': str(backup), 'liveCallVerified': False}))


def rollback(options):
    if os.geteuid() != 0:
        raise RuntimeError('root_required')
    backup = Path(options.rollback)
    manifest = json.loads((backup / 'manifest.json').read_text())
    root = Path(manifest['directory'])
    if list((root / 'pjsip').glob('*.conf')) or list((root / 'dialplan').glob('*.conf')):
        raise RuntimeError('disconnect_external_trunks_before_rollback')
    for item in manifest['changes']:
        if digest(Path(item['path'])) not in (item['after'], item.get('beforeHash')):
            raise RuntimeError('installed_file_changed_review_before_rollback')
    drained(options.asterisk)
    for item in reversed(manifest['changes']):
        path = Path(item['path'])
        if item['before'] is None:
            path.unlink(missing_ok=True)
        else:
            source = backup / str(item['before'])
            write(path, source.read_bytes(), item['beforeMode'], item['beforeUid'], item['beforeGid'])
    run(options.asterisk, '-rx', 'pjsip reload')
    run(options.asterisk, '-rx', 'dialplan reload')
    run('/bin/systemctl', 'daemon-reload')
    run('/bin/systemctl', 'restart', 'ava-telephony-agent.service')
    print(json.dumps({'rolledBack': True}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--install', action='store_true')
    mode.add_argument('--rollback')
    parser.add_argument('--expected-agent-sha')
    parser.add_argument('--agent-target', default='/opt/ava/scripts/telephony/agent.py')
    parser.add_argument('--directory', default='/etc/asterisk/ava-external')
    parser.add_argument('--pjsip-include', default='/etc/asterisk/pjsip_custom_post.conf')
    parser.add_argument('--dialplan-include', default='/etc/asterisk/extensions_custom.conf')
    parser.add_argument('--transports', default='{}')
    parser.add_argument('--backups', default='/var/backups/ava-telephony')
    parser.add_argument('--asterisk', default='/usr/sbin/asterisk')
    args = parser.parse_args()
    try:
        install(args) if args.install else rollback(args)
    except Exception:
        raise SystemExit('External SIP host change stopped; inspect the private backup manifest before proceeding.')
