#!/usr/bin/env python3
"""Replace the dead Instagram-only SSH forward with a private Squid listener.

No CRM environment, Docker container, global route, database or TLS validation
changes. The distribution's generic Squid service stays masked.
"""
import argparse
import datetime
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import subprocess

UNIT = 'ava-instagram-proxy.service'
OLD = 'ava-instagram-proxy-tunnel.service'


def run(args, root, check=True, timeout=120):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                            env=dict(os.environ, DEBIAN_FRONTEND='noninteractive', NEEDRESTART_MODE='l'))
    if result.returncode and check:
        (root / 'last-command.private.log').write_text(result.stdout + result.stderr)
        raise RuntimeError('PROXY_COMMAND_FAILED')
    return result.stdout


def containers(root):
    ids = run(['docker', 'ps', '-aq'], root).split()
    rows = json.loads(run(['docker', 'inspect', *ids], root))
    return {r['Name']: [r['Id'], r['Image'], r['State']['Running'], r.get('RestartCount')]
            for r in rows}


def configuration(gateway, subnet, port):
    gateway = ipaddress.ip_address(gateway)
    network = ipaddress.ip_network(subnet)
    assert gateway.is_private and gateway in network and gateway.version == 4
    assert 1024 <= port <= 65535
    return f'''# Dedicated AVA Instagram CONNECT transport; no TLS interception.
http_port {gateway}:{port}
visible_hostname ava-instagram-proxy
acl ava_clients src {network}
acl instagram dstdomain .instagram.com
acl CONNECT method CONNECT
acl SSL_ports port 443
acl private_destinations dst 0.0.0.0/8 10.0.0.0/8 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 ::1/128 fc00::/7 fe80::/10
http_access deny !CONNECT
http_access deny !SSL_ports
http_access deny private_destinations
http_access allow ava_clients instagram
http_access deny all
cache deny all
cache_mem 8 MB
access_log none
cache_store_log none
cache_log /var/log/squid/ava-instagram-cache.log
pid_filename /run/squid/ava-instagram/squid.pid
netdb_filename none
forwarded_for delete
connect_timeout 10 seconds
request_timeout 20 seconds
read_timeout 60 seconds
shutdown_lifetime 3 seconds
'''


SERVICE = '''[Unit]
Description=AVA Instagram-only private CONNECT proxy
After=network-online.target docker.service
Wants=network-online.target
[Service]
Type=simple
User=proxy
Group=proxy
RuntimeDirectory=squid/ava-instagram
LogsDirectory=squid
ExecStartPre=/usr/sbin/squid -k parse -f /etc/squid/ava-instagram.conf
ExecStart=/usr/sbin/squid -N -f /etc/squid/ava-instagram.conf
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/log/squid /run/squid/ava-instagram
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
[Install]
WantedBy=multi-user.target
'''


def install(root):
    assert not (root / 'installed.json').exists(), 'PROXY_ALREADY_INSTALLED'
    assert not Path('/usr/sbin/squid').exists(), 'EXISTING_SQUID_REQUIRES_REVIEW'
    # Prevent the package's broad default listener from ever starting.
    run(['systemctl', 'mask', 'squid.service'], root)
    run(['apt-get', 'update'], root, timeout=240)
    policy = run(['apt-cache', 'policy', 'squid'], root)
    version = next(x.split(':', 1)[1].strip() for x in policy.splitlines() if 'Candidate:' in x)
    assert version != '(none)', 'SQUID_PACKAGE_UNAVAILABLE'
    plan = run(['apt-get', '-s', 'install', '--no-upgrade', '--no-install-recommends', 'squid=' + version], root)
    assert '0 upgraded,' in plan and '\nRemv ' not in plan, 'UNRELATED_PACKAGE_CHANGE'
    (root / 'package-plan.private.txt').write_text(plan)
    run(['apt-get', '-y', 'install', '--no-upgrade', '--no-install-recommends', 'squid=' + version], root, timeout=240)
    assert run(['systemctl', 'is-enabled', 'squid.service'], root, check=False).strip() == 'masked'
    (root / 'installed.json').write_text(json.dumps({'version': version, 'defaultServiceMasked': True}))
    print(json.dumps({'phase': 'proxy_package_installed', 'version': version}), flush=True)


def activate(root, gateway, subnet, port):
    assert not (root / 'before.json').exists(), 'PROXY_ACTIVATION_ALREADY_ATTEMPTED'
    config = Path('/etc/squid/ava-instagram.conf')
    unit = Path('/etc/systemd/system') / UNIT
    assert not config.exists() and not unit.exists(), 'EXISTING_PROXY_CONFIG_REQUIRES_REVIEW'
    before = {'containers': containers(root), 'oldEnabled': run(['systemctl', 'is-enabled', OLD], root, check=False).strip(),
              'oldActive': run(['systemctl', 'is-active', OLD], root, check=False).strip()}
    (root / 'before.json').write_text(json.dumps(before))
    (root / 'old-unit.private.txt').write_text(run(['systemctl', 'cat', OLD], root))
    config.parent.mkdir(mode=0o755, exist_ok=True)
    config.parent.chmod(0o755)
    config.write_text(configuration(gateway, subnet, port)); config.chmod(0o644)
    unit.write_text(SERVICE); unit.chmod(0o644)
    run(['/usr/sbin/squid', '-k', 'parse', '-f', str(config)], root)
    try:
        run(['systemctl', 'disable', '--now', OLD], root)
        run(['systemctl', 'daemon-reload'], root)
        run(['systemctl', 'enable', '--now', UNIT], root)
        assert run(['systemctl', 'is-active', UNIT], root).strip() == 'active', 'PROXY_NOT_ACTIVE'
        assert containers(root) == before['containers'], 'CONTAINER_DRIFT'
    except BaseException:
        rollback(root)
        raise
    receipt = {'phase': 'proxy_activated', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'configurationSha256': hashlib.sha256(config.read_bytes()).hexdigest(),
               'containersPreserved': True, 'instagramOnly': True, 'tlsInterception': False}
    (root / 'activated.json').write_text(json.dumps(receipt))
    print(json.dumps(receipt), flush=True)


def rollback(root):
    before = json.loads((root / 'before.json').read_text())
    run(['systemctl', 'disable', '--now', UNIT], root, check=False)
    if before['oldEnabled'] == 'enabled': run(['systemctl', 'enable', OLD], root)
    if before['oldActive'] == 'active': run(['systemctl', 'start', OLD], root)
    print(json.dumps({'phase': 'proxy_rolled_back', 'containersChanged': False}), flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['install', 'activate', 'rollback'])
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--gateway'); parser.add_argument('--subnet'); parser.add_argument('--port', type=int, default=8890)
    args = parser.parse_args(); args.root.mkdir(parents=True, mode=0o700, exist_ok=True)
    try:
        with open('/var/lock/ava-instagram-proxy-release.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.mode == 'install': install(args.root)
            elif args.mode == 'activate': activate(args.root, args.gateway, args.subnet, args.port)
            else: rollback(args.root)
    except Exception as error:
        message = str(error)
        print(json.dumps({'phase': 'failed', 'code': message if message.replace('_', '').isalnum()
                         else type(error).__name__}), flush=True)
        raise SystemExit(1)
