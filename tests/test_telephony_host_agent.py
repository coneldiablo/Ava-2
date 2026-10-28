"""Host HTTP/config tests use a local fake Asterisk CLI; no registration/calls."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import socket
import threading
import tempfile
import http.client
import os
import subprocess
import sys
import time

import pytest

SPEC = importlib.util.spec_from_file_location('ava_telephony_agent', Path(__file__).resolve().parents[1] / 'scripts/telephony/agent.py')
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)
PHONE = '12345678-abcd-abcd-abcd-123456789abc'
ENDPOINT = 'ava-phone-' + PHONE.replace('-', '')
DATA = {'phoneId': PHONE, 'endpoint': ENDPOINT, 'number': '79991234567', 'credentials': {'login': '12345678901', 'password': 'Test-credential_1', 'domain': 'sip.exolve.ru'}}


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(agent, 'RECORDING_DIR', tmp_path)
    monkeypatch.setenv('AVA_TELEPHONY_CONFIG_DIR', str(tmp_path))
    monkeypatch.setenv('AVA_TELEPHONY_AGENT_TOKEN', 'a' * 48)
    monkeypatch.setenv('AVA_TELEPHONY_EXOLVE_ENDPOINT', 'exolve-ingress')
    monkeypatch.setenv('AVA_TELEPHONY_TRANSPORT', 'transport-udp')
    monkeypatch.setenv('AVA_TELEPHONY_SIP_DOMAINS', 'sip.exolve.ru')
    monkeypatch.setenv('AVA_TELEPHONY_CRM_URL', 'http://127.0.0.1:3001')
    monkeypatch.setenv('CRM_SERVICE_API_TOKEN', 'service-test-token')
    return tmp_path


def fake_cli(command):
    return {'pjsip reload': '', 'dialplan show ava-exolve-managed': 'ava-managed-resolve',
            'dialplan show ava-managed-resolve': 'AAVA_MANAGED_INGRESS Stasis(asterisk-ai-voice-agent)',
            'ari show apps': 'asterisk-ai-voice-agent', 'pjsip show transports': 'transport-udp',
            'core show application MixMonitor': 'MixMonitor(filename.extension,[options,[command]])',
            'dialplan show ava-managed-record': 'MixMonitor AAVA_RECORDING_STARTED',
            'dialplan show ava-managed-outbound-record': 'Stasis(asterisk-ai-voice-agent,outbound_recorded,...)',
            'pjsip show endpoint exolve-ingress': 'context : ava-exolve-managed',
            'pjsip show endpoint ' + ENDPOINT: 'Endpoint: ' + ENDPOINT,
            'pjsip show registration ' + ENDPOINT + '-reg': 'Registered',
            'core show channels concise': 'PJSIP/owned!context!s!1!Up!Stasis\nPJSIP/staff!context!s!1!Up!Dial'}[command]


@pytest.mark.parametrize('field,value', [('endpoint', '../outside'), ('phoneId', '87654321-abcd-abcd-abcd-123456789abc'), ('number', '79991234567\n[extra]'), ('credentials', None)])
def test_generation_rejects_injection_and_scope(env, field, value):
    data = copy.deepcopy(DATA)
    data[field] = value
    with pytest.raises(ValueError):
        agent.render(data)


@pytest.mark.parametrize('key,value', [('password', 'value\n[extra]'), ('password', 'value;include'), ('domain', 'evil.example'), ('login', '100\npassword=evil')])
def test_credentials_are_not_config_syntax(env, key, value):
    data = copy.deepcopy(DATA)
    data['credentials'][key] = value
    with pytest.raises(ValueError):
        agent.render(data)


def test_generation_scope_permissions_and_reapply_checks_runtime(env, monkeypatch):
    calls = []
    monkeypatch.setattr(agent, 'cli', lambda cmd: calls.append(cmd) or fake_cli(cmd))
    assert agent.manage(DATA) == {'success': True}
    path = env / (ENDPOINT + '.conf')
    assert path.stat().st_mode & 0o777 == 0o600
    content = path.read_text()
    assert 'context=ava-managed-sip-reject' in content and '[{}-reg]'.format(ENDPOINT) in content
    assert 'direct_media=no' in content and 'send_pai=yes' in content
    assert len([line for line in content.splitlines() if line.startswith('[')]) == 4
    assert agent.manage(DATA) == {'success': True}
    assert calls.count('pjsip reload') == 2  # same disk content may be absent from Asterisk after restart


def test_failed_reload_restores_previous_file(env, monkeypatch):
    path = env / (ENDPOINT + '.conf')
    previous = agent.render(DATA)
    path.write_text(previous)
    modified = copy.deepcopy(DATA)
    modified['credentials']['password'] = 'new-test-password'
    calls = []
    def failing(command):
        calls.append(command)
        if len(calls) == 1:
            raise RuntimeError('simulated reload failure')
        return ''
    monkeypatch.setattr(agent, 'cli', failing)
    with pytest.raises(RuntimeError):
        agent.manage(modified)
    assert path.read_text() == previous
    assert calls == ['pjsip reload', 'pjsip reload']


def test_failed_first_apply_removes_only_its_file(env, monkeypatch):
    other = env / 'manual.conf'
    other.write_text('untouched')
    monkeypatch.setattr(agent, 'cli', lambda cmd: '' if cmd == 'pjsip reload' else 'Unable to find object')
    with pytest.raises(ValueError, match='endpoint_not_loaded'):
        agent.manage(DATA)
    assert not (env / (ENDPOINT + '.conf')).exists()
    assert other.read_text() == 'untouched'


def test_remove_verifies_runtime_and_rolls_back(env, monkeypatch):
    path = env / (ENDPOINT + '.conf')
    previous = agent.render(DATA)
    path.write_text(previous)
    monkeypatch.setattr(agent, 'cli', fake_cli)
    with pytest.raises(ValueError, match='endpoint_still_loaded'):
        agent.manage({'endpoint': ENDPOINT}, remove=True)
    assert path.read_text() == previous
    monkeypatch.setattr(agent, 'cli', lambda cmd: '' if cmd == 'pjsip reload' else 'Unable to find object')
    assert agent.manage({'endpoint': ENDPOINT}, remove=True)['success']
    assert not path.exists()
    assert agent.manage({'endpoint': ENDPOINT}, remove=True)['success']


def test_manual_file_and_symlink_are_never_overwritten(env, monkeypatch):
    path = env / (ENDPOINT + '.conf')
    path.write_text('[manual]\n')
    monkeypatch.setattr(agent, 'cli', lambda _: pytest.fail('must not reload'))
    with pytest.raises(ValueError, match='unowned_config'):
        agent.manage(DATA)
    path.unlink()
    other = env / 'unrelated.conf'
    other.write_text('preserved')
    path.symlink_to(other)
    with pytest.raises(ValueError, match='invalid_path'):
        agent.manage(DATA)
    assert other.read_text() == 'preserved'


@pytest.fixture
def server(env, monkeypatch):
    monkeypatch.setattr(agent, 'cli', fake_cli)
    # Real Unix socket transport; HTTP calls never reach provider or real Asterisk.
    short_dir = tempfile.TemporaryDirectory(prefix='ava-uds-', dir='/tmp')
    path = short_dir.name + '/agent.sock'
    srv = agent.UnixServer(path, agent.Handler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    path_socket = path
    def request(path, data=None, token='a' * 48):
        conn = http.client.HTTPConnection('localhost')
        conn.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.sock.connect(path_socket)
        conn.request('POST', path, body=json.dumps(data if data is not None else {}), headers={'Authorization': 'Bearer ' + token})
        response = conn.getresponse()
        result = response.status, json.loads(response.read())
        conn.close()
        return result
    yield request
    srv.shutdown()
    srv.server_close()
    thread.join()
    short_dir.cleanup()


def test_socket_auth_errors_and_output_have_no_secrets(server, capsys):
    assert server('/apply', DATA, token='wrong')[0] == 403
    status, body = server('/apply', {**DATA, 'credentials': {'password': 'SENTINEL-SECRET'}})
    assert status == 503 and body == {'success': False, 'code': 'TELEPHONY_AGENT_OPERATION_FAILED'}
    assert 'SENTINEL-SECRET' not in str(body) + str(capsys.readouterr())
    assert server('/health', ['not-an-object'])[0] == 503
    assert server('/status', {'endpoint': ENDPOINT}) == (200, {'success': True, 'registered': True})
    assert server('/calls') == (200, {'success': True, 'active': 2})


def test_health_requires_context_app_transport_and_operator_gate(server, monkeypatch):
    assert server('/health') == (200, {'success': True, 'recordingReady': True, 'ingressReady': False})
    monkeypatch.setenv('AVA_TELEPHONY_INGRESS_VERIFIED', 'true')
    assert server('/health') == (200, {'success': True, 'recordingReady': True, 'ingressReady': True})
    for wrong in ('pjsip show endpoint exolve-ingress', 'ari show apps', 'pjsip show transports', 'dialplan show ava-managed-resolve',
                  'core show application MixMonitor', 'dialplan show ava-managed-record', 'dialplan show ava-managed-outbound-record'):
        monkeypatch.setattr(agent, 'cli', lambda cmd, missing=wrong: '' if cmd == missing else fake_cli(cmd))
        assert server('/health')[1]['ingressReady'] is False


def test_resolver_validates_exact_did_scope_and_refuses_redirect(env, monkeypatch):
    data = {'success': True, 'businessId': 7, 'phoneId': PHONE, 'number': DATA['number']}
    class Opener:
        def open(self, request, timeout):
            assert request.full_url.startswith('http://127.0.0.1:3001/api/internal/telephony/resolve/')
            return io.BytesIO(json.dumps(data).encode())
    monkeypatch.setattr(agent.urllib.request, 'build_opener', lambda *args: Opener())
    assert agent.resolve('+79991234567') == '7|' + PHONE + '|79991234567'
    data['businessId'] = True
    with pytest.raises(ValueError):
        agent.resolve(DATA['number'])
    data['businessId'] = 7
    data['number'] = '79991234568'
    with pytest.raises(ValueError, match='invalid_number'):
        agent.resolve(DATA['number'])
    with pytest.raises(ValueError, match='crm_redirect_refused'):
        agent.NoRedirect().redirect_request(None, None, None, None, None, 'http://external.example')
    monkeypatch.setenv('AVA_TELEPHONY_CRM_URL', 'http://127.0.0.1:3001@external.example')
    with pytest.raises(ValueError, match='crm_must_be_loopback'):
        agent.resolve(DATA['number'])


def test_dialplan_contains_exact_guard_and_preserves_existing_app():
    root = Path(__file__).resolve().parents[1]
    text = (root / 'config/asterisk/ava-managed-extensions.conf').read_text()
    assert '[ava-exolve-managed]' in text and '[ava-managed-resolve]' in text
    assert 'Stasis(asterisk-ai-voice-agent)' in text
    assert '8097/resolve/' in text and '8090' not in text
    assert text.index('GotoIf($["${AAVA_BUSINESS_ID}"') < text.index('Stasis(')
    assert 'default' not in text


def test_systemd_stop_start_preserves_worker_socket_directory_mount():
    import configparser
    import shlex

    root = Path(__file__).resolve().parents[1]
    unit = configparser.ConfigParser(interpolation=None)
    unit.read(root / 'config/systemd/ava-telephony-agent.service')
    service = unit['Service']
    # A directory bind mount keeps its inode, even if systemd replaces the path.
    assert service['RuntimeDirectory'] == 'ava-telephony'
    assert service.get('RuntimeDirectoryPreserve') == 'yes'
    # Restart cleanup may replace the socket, but must never remove its parent.
    assert shlex.split(service['ExecStopPost']) == [
        '/usr/bin/rm', '-f', '/run/ava-telephony/agent.sock',
    ]


def test_agent_process_stop_start_reconnects_through_preserved_directory(tmp_path):
    """Exercise real processes/UDS; emulate unit cleanup, without systemd or mounts."""
    fake_asterisk = tmp_path / 'asterisk'
    fake_asterisk.write_text('#!' + sys.executable + '\nprint("")\n')
    fake_asterisk.chmod(0o700)
    with tempfile.TemporaryDirectory(prefix='ava-life-', dir='/tmp') as directory:
        path = Path(directory) / 'agent.sock'
        held_directory = os.open(directory, os.O_RDONLY)
        inode = os.fstat(held_directory).st_ino
        child_env = {**os.environ, 'AVA_TELEPHONY_AGENT_SOCKET': str(path),
                     'AVA_TELEPHONY_AGENT_TOKEN': 'a' * 48,
                     'AVA_TELEPHONY_RESOLVER_PORT': '0', 'AVA_ASTERISK_BIN': str(fake_asterisk)}
        def request():
            conn = http.client.HTTPConnection('localhost', timeout=1)
            conn.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            conn.sock.settimeout(1)
            conn.sock.connect(str(path))
            conn.request('POST', '/calls', body='{}', headers={'Authorization': 'Bearer ' + 'a' * 48})
            response = conn.getresponse()
            result = (response.status, json.loads(response.read()))
            conn.close()
            return result
        try:
            for _ in range(2):
                child = subprocess.Popen([sys.executable, str(SPEC.origin)], env=child_env,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    deadline = time.monotonic() + 5
                    while True:
                        assert child.poll() is None, child.communicate()
                        try:
                            result = request()
                            break
                        except (FileNotFoundError, ConnectionRefusedError):
                            if time.monotonic() >= deadline:
                                raise
                            time.sleep(0.01)
                    assert result == (200, {'success': True, 'active': 0})
                    assert Path(directory).stat().st_ino == inode
                    assert os.stat('agent.sock', dir_fd=held_directory).st_ino == path.stat().st_ino
                finally:
                    child.terminate()
                    child.communicate(timeout=5)
                    # Exact ExecStopPost semantics: unlink socket only.
                    path.unlink(missing_ok=True)
                assert Path(directory).stat().st_ino == inode
        finally:
            os.close(held_directory)


def test_health_missing_recording_directory_is_not_ready(server, monkeypatch, tmp_path):
    monkeypatch.setenv('AVA_TELEPHONY_INGRESS_VERIFIED', 'true')
    monkeypatch.setattr(agent, 'RECORDING_DIR', tmp_path / 'missing')
    assert server('/health') == (200, {'success': True, 'recordingReady': False, 'ingressReady': False})
