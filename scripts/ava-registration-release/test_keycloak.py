"""Keycloak client and SMTP tests with all HTTP, SMTP, and Docker I/O faked."""
import contextlib
import copy
import importlib.util
import io
import json
import pathlib
import smtplib
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('registration_keycloak_operator', pathlib.Path(__file__).with_name('keycloak_operator.py'))
kc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kc)


class KeycloakFixture:
    def __init__(self, root):
        self.client = {'id': 'client-id', 'clientId': 'ava-web', 'enabled': True, 'standardFlowEnabled': True,
            'redirectUris': ['https://wh.meludtech.tech/existing', 'http://localhost:3000/callback'],
            'webOrigins': ['https://wh.meludtech.tech'], 'secret': 'client-secret-private',
            'attributes': {'pkce.code.challenge.method': 'S256'}, 'protocolMappers': [{'name': 'preserve'}]}
        self.original = copy.deepcopy(self.client)
        self.smtp = {'host': 'smtp.fixture.invalid', 'from': 'sender@fixture.invalid', 'port': '587',
            'starttls': 'true', 'auth': 'true', 'user': 'smtp-user-private', 'password': 'smtp-password-private'}
        self.requests = []
        self.bad_readback = False
        self.operator = object.__new__(kc.KeycloakOperator)
        self.operator.path = root / 'keycloak.private.json'
        self.operator.token = 'token-private'
        self.operator.request = self.request
        self.operator.smtp = mock.Mock(return_value={'configured': True, 'tlsVerified': True, 'mailSent': False})

    def request(self, path, body=None, method=None, content_type='application/json'):
        self.requests.append((path, body, method))
        if path == '/admin/realms/ava':
            return {'smtpServer': copy.deepcopy(self.smtp)}
        if path.endswith('?clientId=ava-web'):
            return [{'id': self.client['id'], 'clientId': 'ava-web'}]
        if method == 'PUT':
            self.client = json.loads(body)
            if self.bad_readback:
                self.client['attributes']['unexpected-server-change'] = 'changed'
            return None
        return copy.deepcopy(self.client)

    def puts(self):
        return [request for request in self.requests if request[2] == 'PUT']


class KeycloakTests(unittest.TestCase):
    def fixture(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = pathlib.Path(temp.name)
        root.chmod(0o700)
        return KeycloakFixture(root)

    def test_plan_is_private_read_only_and_appends_only_exact_redirect(self):
        f = self.fixture()
        receipt = f.operator.plan()
        state = json.loads(f.operator.path.read_text())
        self.assertEqual(state['before'], f.original)
        self.assertEqual(state['after']['redirectUris'], f.original['redirectUris'] + [kc.REDIRECT])
        self.assertEqual(kc.without_redirect(state['after']), kc.without_redirect(f.original))
        self.assertEqual(f.operator.path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(receipt['mutation'])
        self.assertFalse(f.puts())
        for secret in ('client-secret-private', 'smtp-password-private', 'token-private'):
            self.assertNotIn(secret, json.dumps(receipt))

    def test_apply_and_retry_preserve_full_client_then_rollback_exact_prior_list(self):
        f = self.fixture()
        f.operator.plan()
        f.operator.apply()
        self.assertEqual(f.client['redirectUris'], f.original['redirectUris'] + [kc.REDIRECT])
        self.assertEqual(kc.without_redirect(f.client), kc.without_redirect(f.original))
        f.operator.apply()
        self.assertEqual(len(f.puts()), 1)
        f.operator.verify()
        f.operator.rollback()
        self.assertEqual(f.client, f.original)
        self.assertEqual(len(f.puts()), 2)
        f.operator.rollback()
        self.assertEqual(len(f.puts()), 2)

    def test_already_present_redirect_is_idempotent(self):
        f = self.fixture()
        f.client['redirectUris'].append(kc.REDIRECT)
        before = copy.deepcopy(f.client)
        f.operator.plan()
        f.operator.apply()
        f.operator.rollback()
        self.assertEqual(f.client, before)
        self.assertFalse(f.puts())

    def test_compare_immediately_before_put_rejects_client_drift(self):
        f = self.fixture()
        f.operator.plan()
        f.client['attributes']['new-admin-setting'] = 'preserve'
        with self.assertRaisesRegex(RuntimeError, 'KEYCLOAK_CLIENT_DRIFT'):
            f.operator.apply()
        self.assertFalse(f.puts())

    def test_readback_must_match_full_client_exactly(self):
        f = self.fixture()
        f.operator.plan()
        f.bad_readback = True
        with self.assertRaisesRegex(RuntimeError, 'KEYCLOAK_CLIENT_READBACK_MISMATCH'):
            f.operator.apply()
        self.assertEqual(len(f.puts()), 1)

    def test_plan_cannot_be_edited_to_mutate_other_client_fields(self):
        f = self.fixture()
        f.operator.plan()
        state = json.loads(f.operator.path.read_text())
        state['after']['webOrigins'].append('https://unexpected.invalid')
        f.operator.path.write_text(json.dumps(state))
        with self.assertRaisesRegex(RuntimeError, 'KEYCLOAK_SCOPED_DIFF_INVALID'):
            f.operator.apply()
        self.assertFalse(f.puts())

    def test_smtp_failure_blocks_put_and_mail_sending(self):
        f = self.fixture()
        f.operator.plan()
        f.operator.smtp.side_effect = RuntimeError('KEYCLOAK_SMTP_PROBE_FAILED')
        with self.assertRaisesRegex(RuntimeError, 'KEYCLOAK_SMTP_PROBE_FAILED'):
            f.operator.apply()
        self.assertFalse(f.puts())
        self.assertEqual(f.client, f.original)

    def test_smtp_starttls_authenticates_without_mail_commands(self):
        f = self.fixture()
        smtp = mock.Mock()
        with mock.patch.object(kc.smtplib, 'SMTP', return_value=smtp) as connect:
            receipt = kc.KeycloakOperator.smtp(f.operator)
        connect.assert_called_once_with('smtp.fixture.invalid', 587, timeout=15)
        self.assertEqual(smtp.ehlo.call_count, 2)
        smtp.starttls.assert_called_once()
        smtp.login.assert_called_once_with('smtp-user-private', 'smtp-password-private')
        smtp.quit.assert_called_once()
        for name in ('mail', 'rcpt', 'data', 'sendmail', 'send_message'):
            getattr(smtp, name).assert_not_called()
        self.assertFalse(receipt['mailSent'])
        self.assertTrue(receipt['authenticationRequired'])
        self.assertNotIn('smtp-password-private', json.dumps(receipt))

    def test_smtp_ssl_and_failed_auth_are_sanitized(self):
        f = self.fixture()
        f.smtp.update(ssl='true', starttls='false', port='465')
        smtp = mock.Mock()
        smtp.login.side_effect = smtplib.SMTPAuthenticationError(535, b'smtp-password-private rejected')
        with mock.patch.object(kc.smtplib, 'SMTP_SSL', return_value=smtp) as connect:
            with self.assertRaisesRegex(RuntimeError, '^KEYCLOAK_SMTP_PROBE_FAILED$'):
                kc.KeycloakOperator.smtp(f.operator)
        self.assertEqual(connect.call_args.args, ('smtp.fixture.invalid', 465))
        smtp.starttls.assert_not_called()
        smtp.quit.assert_called_once()

    def test_smtp_requires_config_and_tls_before_connecting(self):
        f = self.fixture()
        for config, error in (({}, 'KEYCLOAK_SMTP_NOT_CONFIGURED'),
                ({'host': 'smtp.fixture.invalid', 'from': 'sender@fixture.invalid'}, 'KEYCLOAK_SMTP_TLS_REQUIRED')):
            f.smtp = config
            with mock.patch.object(kc.smtplib, 'SMTP') as connect:
                with self.assertRaisesRegex(RuntimeError, error):
                    kc.KeycloakOperator.smtp(f.operator)
                connect.assert_not_called()

    def test_masked_smtp_password_requires_private_regular_file(self):
        f = self.fixture()
        f.smtp['password'] = '**********'
        secret = f.operator.path.parent / 'smtp-password'
        secret.write_text('private-file-smtp-secret\n')
        secret.chmod(0o644)
        link = secret.with_name('password-link')
        link.symlink_to(secret)
        for path in (None, secret, link):
            f.operator.smtp_password_file = path
            smtp = mock.Mock()
            with self.subTest(path=str(path)), mock.patch.object(kc.smtplib, 'SMTP', return_value=smtp):
                with self.assertRaisesRegex(RuntimeError, '^KEYCLOAK_SMTP_SECRET_REDACTED$'):
                    kc.KeycloakOperator.smtp(f.operator)
            smtp.login.assert_not_called()
            smtp.quit.assert_called_once()

    def test_masked_smtp_password_uses_mode600_file_without_receipt_secret(self):
        f = self.fixture()
        f.smtp['password'] = '**********'
        secret = f.operator.path.parent / 'smtp-password'
        secret.write_text('private-file-smtp-secret\n')
        secret.chmod(0o600)
        f.operator.smtp_password_file = secret
        smtp = mock.Mock()
        with mock.patch.object(kc.smtplib, 'SMTP', return_value=smtp):
            receipt = kc.KeycloakOperator.smtp(f.operator)
        smtp.login.assert_called_once_with('smtp-user-private', 'private-file-smtp-secret')
        self.assertTrue(receipt['connectionVerified'])
        self.assertFalse(receipt['mailSent'])
        self.assertNotIn('private-file-smtp-secret', json.dumps(receipt))
        for name in ('mail', 'rcpt', 'data', 'sendmail', 'send_message'):
            getattr(smtp, name).assert_not_called()

    def test_admin_http_disables_redirects_and_rejects_changed_final_url(self):
        f = self.fixture()
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.geturl.return_value = 'https://attacker.fixture.invalid/receive-token'
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(kc.urllib.request, 'build_opener', return_value=opener) as create:
            with self.assertRaisesRegex(RuntimeError, '^KEYCLOAK_REDIRECT_FORBIDDEN$'):
                kc.KeycloakOperator.request(f.operator, '/admin/realms/ava')
        create.assert_called_once()
        handler = create.call_args.args[0]
        self.assertTrue(issubclass(handler, kc.urllib.request.HTTPRedirectHandler))
        self.assertIsNone(handler().redirect_request(None, None, 302, 'redirect', {}, 'https://attacker.fixture.invalid'))
        response.read.assert_not_called()

    def test_constructor_reads_credentials_in_memory_never_docker_argv(self):
        f = self.fixture()
        inspect = [{'State': {'Running': True}, 'Config': {'Env': [
            'KC_BOOTSTRAP_ADMIN_USERNAME=admin-private', 'KC_BOOTSTRAP_ADMIN_PASSWORD=admin-password-private']}}]
        with mock.patch.object(kc.subprocess, 'check_output', return_value=json.dumps(inspect)) as docker:
            with mock.patch.object(kc.KeycloakOperator, 'request', return_value={'access_token': 'token-private'}) as request:
                operator = kc.KeycloakOperator(f.operator.path, 'keycloak-fixture')
        self.assertEqual(operator.token, 'token-private')
        self.assertNotIn('admin-password-private', json.dumps(docker.call_args.args))
        body = request.call_args.kwargs['body']
        self.assertIn(b'password=admin-password-private', body)

    def test_cli_errors_never_echo_credentials_from_exceptions(self):
        f = self.fixture()
        stdout = io.StringIO()
        with mock.patch('sys.argv', ['keycloak_operator.py', 'plan', '--state', str(f.operator.path)]), \
                mock.patch.object(kc, 'KeycloakOperator', side_effect=ValueError('smtp-password-private')), \
                mock.patch('builtins.open', mock.mock_open()), mock.patch('fcntl.flock'), \
                contextlib.redirect_stdout(stdout):
            result = kc.main()
        self.assertEqual(result, 1)
        value = json.loads(stdout.getvalue())
        self.assertEqual(value['reason'], 'KEYCLOAK_OPERATOR_FAILED_VALUEERROR')
        self.assertNotIn('smtp-password-private', stdout.getvalue())


if __name__ == '__main__':
    unittest.main()
