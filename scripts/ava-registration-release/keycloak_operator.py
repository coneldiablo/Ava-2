#!/usr/bin/env python3
"""Scoped Keycloak ava-web redirect operator; no realm import/restart/mail send."""
from __future__ import annotations
import argparse
import copy
import datetime
import hashlib
import json
import os
import pathlib
import smtplib
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

REDIRECT = 'https://wh.meludtech.tech/api/auth/sso/start'
ORIGIN = 'https://auth.meludtech.tech'
REALM = 'ava'
CLIENT = 'ava-web'


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def digest(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def private_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(pathlib.Path(path).parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def without_redirect(client):
    result = copy.deepcopy(client)
    result.pop('redirectUris', None)
    return result


class KeycloakOperator:
    def __init__(self, state, container=None, smtp_password_file=None):
        self.path = pathlib.Path(state)
        self.smtp_password_file = pathlib.Path(smtp_password_file) if smtp_password_file else None
        require(not self.path.is_symlink() and self.path.parent.is_dir(), 'KEYCLOAK_STATE_PATH_INVALID')
        require(self.path.parent.stat().st_mode & 0o077 == 0, 'KEYCLOAK_STATE_DIRECTORY_NOT_PRIVATE')
        ids = [container] if container else subprocess.check_output(
            ['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.service=keycloak'], text=True, stderr=subprocess.PIPE).split()
        require(len(ids) == 1, 'KEYCLOAK_CONTAINER_AMBIGUOUS')
        row = json.loads(subprocess.check_output(['docker', 'inspect', ids[0]], text=True, stderr=subprocess.PIPE))[0]
        require(row['State']['Running'], 'KEYCLOAK_NOT_RUNNING')
        env = dict(v.split('=', 1) for v in row['Config']['Env'] if '=' in v)
        username = env.get('KC_BOOTSTRAP_ADMIN_USERNAME') or env.get('KEYCLOAK_ADMIN')
        password = env.get('KC_BOOTSTRAP_ADMIN_PASSWORD') or env.get('KEYCLOAK_ADMIN_PASSWORD')
        require(username and password, 'KEYCLOAK_ADMIN_CREDENTIALS_UNAVAILABLE')
        # Credentials remain in process memory; never argv, stdout, receipts or failure logs.
        body = urllib.parse.urlencode({'grant_type': 'password', 'client_id': 'admin-cli',
                                       'username': username, 'password': password}).encode()
        self.token = self.request('/realms/master/protocol/openid-connect/token', body=body,
                                  content_type='application/x-www-form-urlencoded')['access_token']

    def request(self, path, body=None, method=None, content_type='application/json'):
        headers = {'Content-Type': content_type}
        if getattr(self, 'token', None):
            headers['Authorization'] = 'Bearer ' + self.token
        req = urllib.request.Request(ORIGIN + path, data=body, headers=headers, method=method)
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        try:
            with urllib.request.build_opener(NoRedirect).open(req, timeout=20) as response:
                require(response.geturl() == ORIGIN + path, 'KEYCLOAK_REDIRECT_FORBIDDEN')
                raw = response.read()
                return json.loads(raw) if raw else None
        except (urllib.error.HTTPError, urllib.error.URLError):
            raise RuntimeError('KEYCLOAK_ADMIN_REQUEST_FAILED') from None

    def read_client(self):
        rows = self.request('/admin/realms/ava/clients?clientId=ava-web')
        require(isinstance(rows, list) and len(rows) == 1 and rows[0].get('clientId') == CLIENT,
                'KEYCLOAK_CLIENT_AMBIGUOUS')
        result = self.request('/admin/realms/ava/clients/' + urllib.parse.quote(rows[0]['id'], safe=''))
        require(result.get('enabled') is True and result.get('standardFlowEnabled') is True and
                result.get('clientId') == CLIENT and isinstance(result.get('redirectUris'), list),
                'KEYCLOAK_CLIENT_NOT_READY')
        return result

    def smtp(self):
        realm = self.request('/admin/realms/ava')
        config = realm.get('smtpServer') or {}
        require(config.get('host') and config.get('from'), 'KEYCLOAK_SMTP_NOT_CONFIGURED')
        secure, starttls = config.get('ssl') == 'true', config.get('starttls') == 'true'
        require(secure or starttls, 'KEYCLOAK_SMTP_TLS_REQUIRED')
        port = int(config.get('port') or (465 if secure else 587))
        require(1 <= port <= 65535, 'KEYCLOAK_SMTP_PORT_INVALID')
        context = ssl.create_default_context()
        conn = None
        try:
            conn = (smtplib.SMTP_SSL(config['host'], port, timeout=15, context=context) if secure else
                    smtplib.SMTP(config['host'], port, timeout=15))
            conn.ehlo()
            if starttls and not secure:
                conn.starttls(context=context)
                conn.ehlo()
            if config.get('auth') == 'true':
                require(config.get('user') and config.get('password'), 'KEYCLOAK_SMTP_AUTH_MISSING')
                password = config['password']
                if set(password) == {'*'}:
                    secret = getattr(self, 'smtp_password_file', None)
                    require(secret and secret.is_file() and not secret.is_symlink() and
                            secret.stat().st_mode & 0o077 == 0, 'KEYCLOAK_SMTP_SECRET_REDACTED')
                    password = secret.read_text().rstrip('\r\n')
                    require(password and set(password) != {'*'}, 'KEYCLOAK_SMTP_SECRET_REDACTED')
                conn.login(config['user'], password)
            # No MAIL FROM, RCPT TO, DATA or test email.
            return {'configured': True, 'tlsVerified': True, 'connectionVerified': True,
                    'authenticationRequired': config.get('auth') == 'true', 'mailSent': False}
        except (OSError, smtplib.SMTPException):
            raise RuntimeError('KEYCLOAK_SMTP_PROBE_FAILED') from None
        finally:
            if conn:
                try:
                    conn.quit()
                except Exception:
                    conn.close()

    def plan(self):
        require(not self.path.exists(), 'KEYCLOAK_PLAN_EXISTS')
        before = self.read_client()
        smtp = self.smtp()
        after = copy.deepcopy(before)
        if REDIRECT not in after['redirectUris']:
            after['redirectUris'].append(REDIRECT)
        private_json(self.path, {'schemaVersion': 1, 'origin': ORIGIN, 'realm': REALM, 'clientId': CLIENT,
                                'before': before, 'after': after})
        return self.receipt('planned', before, after, smtp=smtp, mutation=False)

    def load(self):
        require(self.path.is_file() and self.path.stat().st_mode & 0o077 == 0, 'KEYCLOAK_STATE_NOT_PRIVATE')
        state = json.loads(self.path.read_text())
        require(state.get('schemaVersion') == 1 and state.get('origin') == ORIGIN and
                state.get('realm') == REALM and state.get('clientId') == CLIENT, 'KEYCLOAK_STATE_INVALID')
        expected = copy.deepcopy(state['before'])
        if REDIRECT not in expected['redirectUris']:
            expected['redirectUris'].append(REDIRECT)
        require(state['after'] == expected, 'KEYCLOAK_SCOPED_DIFF_INVALID')
        return state

    def write_client(self, expected, target):
        # Keycloak offers no atomic If-Match here. Compare immediately before PUT,
        # preserve the entire representation and verify immediately afterwards.
        current = self.read_client()
        require(current == expected, 'KEYCLOAK_CLIENT_DRIFT')
        require(without_redirect(current) == without_redirect(target), 'KEYCLOAK_UNSCOPED_CHANGE')
        self.request('/admin/realms/ava/clients/' + urllib.parse.quote(current['id'], safe=''),
                     body=json.dumps(target).encode(), method='PUT')
        require(self.read_client() == target, 'KEYCLOAK_CLIENT_READBACK_MISMATCH')

    def apply(self):
        p = self.load()
        smtp = self.smtp()
        current = self.read_client()
        if current != p['after']:
            self.write_client(p['before'], p['after'])
        return self.receipt('applied', p['before'], p['after'], smtp=smtp,
                            mutation=p['before'] != p['after'])

    def verify(self):
        p = self.load()
        require(self.read_client() == p['after'], 'KEYCLOAK_CLIENT_DRIFT')
        return self.receipt('verified', p['before'], p['after'], smtp=self.smtp(), mutation=False)

    def rollback(self):
        p = self.load()
        current = self.read_client()
        if current != p['before']:
            self.write_client(p['after'], p['before'])
        return self.receipt('rolled_back', p['before'], p['before'], mutation=p['before'] != p['after'])

    def receipt(self, phase, before, after, **checks):
        return {'phase': 'keycloak_' + phase, 'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'origin': ORIGIN, 'realm': REALM, 'clientId': CLIENT, 'requiredRedirectUri': REDIRECT,
                'beforeClientSha256': digest(before), 'afterClientSha256': digest(after),
                'priorRedirectsPreserved': set(before['redirectUris']) <= set(after['redirectUris']), **checks}


def main():
    import fcntl
    os.umask(0o077)
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['plan', 'apply', 'verify', 'rollback'])
    p.add_argument('--state', type=pathlib.Path, required=True)
    p.add_argument('--container')
    p.add_argument('--smtp-password-file', type=pathlib.Path)
    args = p.parse_args()
    try:
        with open('/var/lock/ava-registration-release.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            value = getattr(KeycloakOperator(args.state, args.container, args.smtp_password_file), args.action)()
        print(json.dumps(value), flush=True)
        return 0
    except Exception as error:
        code = str(error)
        if not isinstance(error, RuntimeError) or not code.isupper() or not all(c.isalnum() or c == '_' for c in code):
            code = 'KEYCLOAK_OPERATOR_FAILED_' + type(error).__name__.upper()
        print(json.dumps({'phase': 'failed', 'reason': code}), flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
