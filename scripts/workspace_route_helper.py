#!/usr/bin/env python3
"""Restricted A06 Unix-socket helper. No public listener and no arbitrary shell API."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import socketserver
import sqlite3
import ssl
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler
from urllib.request import HTTPSHandler, HTTPRedirectHandler, ProxyHandler, build_opener


DOMAIN = 'crm.meludtech.tech'
SLUG = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\Z')
MARKER = '# Managed by AVA workspace route helper\n'


class RouteError(Exception):
    pass


def validate_request(payload):
    if not isinstance(payload, dict) or set(payload) != {'business_id', 'slug'}:
        raise RouteError('INVALID_ROUTE_REQUEST')
    business_id, slug = payload['business_id'], payload['slug']
    if type(business_id) is not int or business_id < 1 or not isinstance(slug, str):
        raise RouteError('INVALID_ROUTE_REQUEST')
    if not SLUG.fullmatch(slug) or not slug.endswith(f'-{business_id}'):
        raise RouteError('INVALID_WORKSPACE_SLUG')
    return business_id, slug, f'{slug}.{DOMAIN}'


def render_vhost(slug):
    hostname = f'{slug}.{DOMAIN}'
    return MARKER + f'''server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {hostname};
    ssl_certificate /etc/letsencrypt/live/ava-crm-{slug}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ava-crm-{slug}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    server_tokens off;
    # OAuth/SAML callbacks and URLs can contain credentials; never log them.
    access_log off;
    error_log /var/log/nginx/ava-workspaces-error.log crit;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    location / {{
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 10s;
        proxy_read_timeout 120s;
    }}
}}
'''


def run(command):
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=180)
    except (subprocess.SubprocessError, OSError):
        raise RouteError('WORKSPACE_ROUTE_OPERATION_FAILED') from None


def atomic_write(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.ava-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o640)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class WorkspaceRoutes:
    def __init__(self, database, directory='/etc/nginx/ava-workspaces', runner=run, probe=None):
        self.database = Path(database).resolve()
        self.directory = Path(directory)
        self.runner = runner
        self.probe = probe or self._probe

    @staticmethod
    def _probe(hostname):
        # No proxy env or redirect can turn verification into a foreign request.
        opener = build_opener(ProxyHandler({}), HTTPSHandler(context=ssl.create_default_context()), NoRedirect())
        try:
            with opener.open(f'https://{hostname}/healthz', timeout=10) as response:
                if response.status != 200:
                    raise RouteError('WORKSPACE_HTTPS_NOT_VERIFIED')
        except Exception:
            raise RouteError('WORKSPACE_HTTPS_NOT_VERIFIED') from None

    def _reservation(self, business_id, slug):
        with sqlite3.connect(f'{self.database.as_uri()}?mode=ro', uri=True, timeout=5) as db:
            row = db.execute('''SELECT j.checkpointJson,j.leaseToken FROM business_provisioning_jobs j
                JOIN instances i ON i.id=j.businessId WHERE j.businessId=?
                AND j.module='crm_workspace' AND j.status='LEASED' AND i.isActive=1
                AND datetime(j.leasedUntil)>datetime('now')''', (business_id,)).fetchone()
        if not row or not row[1] or json.loads(row[0]).get('slug') != slug:
            raise RouteError('WORKSPACE_RESERVATION_NOT_OWNED')
        return row[1]

    def ensure(self, payload):
        business_id, slug, hostname = validate_request(payload)
        lease = self._reservation(business_id, slug)
        self.directory.mkdir(mode=0o750, parents=True, exist_ok=True)
        target = self.directory / f'{slug}.conf'
        if target.is_symlink():
            raise RouteError('WORKSPACE_ROUTE_NOT_MANAGED')
        old = target.read_text() if target.exists() else None
        if old is not None and not old.startswith(MARKER):
            raise RouteError('WORKSPACE_ROUTE_NOT_MANAGED')
        self.runner(['certbot', 'certonly', '--webroot', '-w', '/var/www/acme',
                     '--cert-name', f'ava-crm-{slug}', '-d', hostname,
                     '--non-interactive', '--keep-until-expiring'])
        # Certificate issuance can outlive a crashed/replaced worker. Do not
        # install its route after the business or lease has changed.
        if self._reservation(business_id, slug) != lease:
            raise RouteError('WORKSPACE_RESERVATION_NOT_OWNED')
        atomic_write(target, render_vhost(slug))
        try:
            self.runner(['nginx', '-t'])
            self.runner(['systemctl', 'reload', 'nginx'])
        except Exception:
            if old is None:
                target.unlink(missing_ok=True)
            else:
                atomic_write(target, old)
            # Restore the previous known configuration, never restart nginx.
            self.runner(['nginx', '-t'])
            self.runner(['systemctl', 'reload', 'nginx'])
            raise
        self.probe(hostname)
        return {'business_id': business_id, 'hostname': hostname, 'https_ready': True}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.connection.settimeout(5)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if self.path != '/workspace/ensure' or not 0 < length <= 1024 or self.headers.get('Transfer-Encoding'):
                raise RouteError('INVALID_ROUTE_REQUEST')
            data = self.server.routes.ensure(json.loads(self.rfile.read(length)))
            status = 200
        except RouteError as error:
            status, data = 409, {'error': str(error)}
        except Exception:
            status, data = 503, {'error': 'WORKSPACE_ROUTE_UNAVAILABLE'}
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--database', required=True)
    parser.add_argument('--socket', default='/run/ava-provisioning/route.sock')
    args = parser.parse_args()
    socket_path = Path(args.socket)
    socket_path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    socket_path.unlink(missing_ok=True)
    # Serial execution also prevents concurrent nginx reload/config races.
    with socketserver.UnixStreamServer(str(socket_path), Handler) as server:
        os.chmod(socket_path, 0o660)
        server.routes = WorkspaceRoutes(args.database)
        server.serve_forever()


if __name__ == '__main__':
    main()
