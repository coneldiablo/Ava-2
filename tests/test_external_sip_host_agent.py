"""Isolated host/config/installer fixtures. No SIP provider or real call."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import http.client
from types import SimpleNamespace

import pytest

BASE = Path(__file__).resolve().parents[1] / 'scripts/telephony'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


external = load('external_fixture', BASE / 'external_sip.py')
agent = load('agent_fixture', BASE / 'agent.py')
installer = load('installer_fixture', BASE / 'install_external_sip.py')
PHONE = '12345678-abcd-abcd-abcd-123456789abc'
ENDPOINT = 'ava-phone-' + PHONE.replace('-', '')
DATA = {'phoneId': PHONE, 'businessId': 9, 'endpoint': ENDPOINT, 'number': '74951110003', 'revision': 1,
        'credentials': {'host': '8.8.8.8', 'port': 5060, 'transport': 'udp', 'login': 'fixture-user',
                        'password': 'Fixture-private-credential', 'addresses': ['8.8.8.8'], 'fingerprint': 'a' * 64}}


@pytest.fixture
def state(tmp_path, monkeypatch):
    directory = tmp_path / 'external'
    directory.mkdir()
    (directory / 'pjsip').mkdir()
    (directory / 'dialplan').mkdir()
    (directory / 'install.json').write_text('{"version":1}')
    monkeypatch.setenv('AVA_TELEPHONY_EXTERNAL_DIR', str(directory))
    monkeypatch.setenv('AVA_TELEPHONY_EXTERNAL_SIP_ENABLED', 'true')
    monkeypatch.setenv('AVA_TELEPHONY_EXTERNAL_TRANSPORTS', '{"udp":"transport-udp","tcp":"transport-tcp"}')
    current = {'businessId': 9, 'phoneId': PHONE, 'number': DATA['number'], 'endpoint': ENDPOINT,
               'revision': 1, 'state': 'provisioning', 'businessActive': True}
    monkeypatch.setattr(external, 'owner', lambda _phone, active=False: current)
    value = {'loaded': False, 'registered': True, 'active': False, 'fail_reload': False, 'calls': [], 'owner': current, 'directory': directory}

    def cli(command):
        value['calls'].append(command)
        if command.startswith('pjsip show transport '):
            return 'protocol : ' + ('tcp' if command.endswith('tcp') else 'tls\nverify_server : no' if command.endswith('tls') else 'udp')
        if command == 'ari show apps':
            return 'asterisk-ai-voice-agent'
        if command == 'core show application MixMonitor':
            return 'MixMonitor(filename)'
        if command == 'core show channels concise':
            return 'PJSIP/old!business-9!s!1!Up!Stasis' if value['active'] else ''
        if command == 'pjsip reload':
            if value['fail_reload']:
                value['fail_reload'] = False
                raise RuntimeError('fixture_reload_failure')
            value['loaded'] = (directory / 'pjsip' / (ENDPOINT + '.conf')).is_file()
            return ''
        if command == 'dialplan reload':
            return ''
        if command == 'pjsip show endpoint ' + ENDPOINT:
            return 'Endpoint: ' + ENDPOINT + '\ncontext : ava-ext-' + PHONE.replace('-', '') if value['loaded'] else 'Unable to find object ' + ENDPOINT
        if command.startswith('dialplan show '):
            return 'AVA_EXT_ROUTE Stasis(asterisk-ai-voice-agent)' if value['loaded'] else 'No context'
        if command == 'pjsip show registration ' + ENDPOINT + '-reg':
            return 'sip:8.8.8.8:5060 ' + ('Registered' if value['registered'] else 'Rejected') if value['loaded'] else 'Unable to find object'
        raise AssertionError('unexpected CLI ' + command)

    value['cli'] = cli
    return value


def test_render_has_public_pinned_transport_and_exact_owned_inbound_route(state):
    pjsip, dialplan, metadata = external.render(copy.deepcopy(DATA), state['cli'])
    assert 'line=yes' in pjsip and 'endpoint=' + ENDPOINT in pjsip
    assert 'outbound_proxy=sip:8.8.8.8:5060\\;transport=udp\\;lr' in pjsip
    assert 'permit=8.8.8.8/32' in pjsip and 'deny=0.0.0.0/0' in pjsip
    assert 'context=ava-ext-' + PHONE.replace('-', '') in pjsip
    assert '9|' + PHONE + '|74951110003|1' in dialplan
    assert 'Set(__AAVA_BUSINESS_ID=9)' in dialplan and 'Set(__AAVA_PHONE_ID=' + PHONE + ')' in dialplan
    assert 'MixMonitor' in dialplan and 'AAVA_RECORDING_STARTED' in dialplan
    assert 'exolve' not in pjsip and 'fixture-user' not in json.dumps(metadata) and DATA['credentials']['password'] not in json.dumps(metadata)


@pytest.mark.parametrize('change', [
    {'login': 'value\n[escape]'}, {'password': 'value;include'}, {'host': '127.0.0.1', 'addresses': ['127.0.0.1']},
    {'host': 'http://8.8.8.8'}, {'port': 0}, {'transport': 'tls'}, {'addresses': ['8.8.8.8', '10.0.0.1']},
])
def test_unsafe_or_unloaded_credentials_never_render(state, change):
    data = copy.deepcopy(DATA)
    data['credentials'].update(change)
    with pytest.raises(ValueError):
        external.render(data, state['cli'])


def test_dns_rebinding_mixed_private_or_changed_public_set_is_rejected(state, monkeypatch):
    data = copy.deepcopy(DATA)
    data['credentials']['host'] = 'sip.example.com'
    for addresses in [['8.8.8.8', '10.0.0.1'], ['1.1.1.1']]:
        monkeypatch.setattr(external.socket, 'getaddrinfo', lambda *_a, **_k: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, 5060)) for ip in addresses])
        with pytest.raises(ValueError, match='public_address_changed'):
            external.render(data, state['cli'])


def test_apply_status_registration_and_call_verification_are_separate_and_files_private(state):
    assert external.status(DATA, state['cli'])['configured'] is False
    assert external.manage(DATA, state['cli'], agent.atomic, threading.Lock()) == {'success': True}
    observed = external.status(DATA, state['cli'])
    assert observed['configured'] is True and observed['registered'] is True
    assert observed['revision'] == 1 and observed['fingerprint'] == 'a' * 64
    for path in external.paths(DATA):
        assert path.stat().st_mode & 0o777 == 0o600
    state['registered'] = False
    assert external.status(DATA, state['cli'])['configured'] is True
    assert external.status(DATA, state['cli'])['registered'] is False
    state['loaded'] = False
    assert external.status(DATA, state['cli'])['configured'] is False  # files alone are not proof
    state['owner']['revision'] = 2
    with pytest.raises(ValueError, match='owner_changed'):
        external.status(DATA, state['cli'])


def test_active_call_guards_owned_remove_and_reload_failure_rolls_back_only_owned_files(state):
    unrelated = state['directory'] / 'pjsip' / 'existing-operator.conf'
    unrelated.write_text('; unrelated')
    state['active'] = True
    with pytest.raises(ValueError, match='active_calls'):
        external.manage(DATA, state['cli'], agent.atomic, threading.Lock())
    assert not external.paths(DATA)[0].exists()
    state['active'] = False
    state['fail_reload'] = True
    with pytest.raises(RuntimeError):
        external.manage(DATA, state['cli'], agent.atomic, threading.Lock())
    assert not any(path.exists() for path in external.paths(DATA))
    external.manage(DATA, state['cli'], agent.atomic, threading.Lock())
    state['active'] = True
    with pytest.raises(ValueError, match='active_calls'):
        external.manage(DATA, state['cli'], agent.atomic, threading.Lock(), remove=True)
    state['active'] = False
    external.manage(DATA, state['cli'], agent.atomic, threading.Lock(), remove=True)
    assert external.status(DATA, state['cli'])['configured'] is False
    assert unrelated.read_text() == '; unrelated'


def test_unknown_or_foreign_runtime_and_modified_files_are_not_overwritten(state):
    state['loaded'] = True
    with pytest.raises(ValueError, match='orphaned_runtime'):
        external.status(DATA, state['cli'])
    with pytest.raises(ValueError, match='orphaned_runtime'):
        external.manage(DATA, state['cli'], agent.atomic, threading.Lock(), remove=True)
    state['loaded'] = False
    external.manage(DATA, state['cli'], agent.atomic, threading.Lock())
    path = external.paths(DATA)[0]
    path.write_text(path.read_text() + '\n; external operator changed')
    with pytest.raises(ValueError, match='config_changed'):
        external.manage(DATA, state['cli'], agent.atomic, threading.Lock(), remove=True)


def test_capabilities_installation_and_verified_tls_transport_are_fail_closed(state, monkeypatch):
    assert external.capabilities(state['cli'])['transports'] == ['tcp', 'udp']
    monkeypatch.setenv('AVA_TELEPHONY_EXTERNAL_TRANSPORTS', '{"tls":"transport-tls"}')
    assert external.capabilities(state['cli'])['available'] is False
    monkeypatch.setenv('AVA_TELEPHONY_EXTERNAL_SIP_ENABLED', 'false')
    assert external.capabilities(state['cli']) == {'success': True, 'available': False, 'transports': []}


def test_real_unix_http_new_actions_require_token_and_resolver_cannot_apply(state, monkeypatch, tmp_path):
    monkeypatch.setenv('AVA_TELEPHONY_AGENT_TOKEN', 'a' * 48)
    monkeypatch.setattr(agent, 'external_module', lambda: external)
    monkeypatch.setattr(agent, 'cli', state['cli'])
    socket_directory = tempfile.TemporaryDirectory(prefix='ava-xs-', dir='/tmp')
    socket_path = str(Path(socket_directory.name) / 'agent.sock')
    server = agent.UnixServer(socket_path, agent.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def post(path, token=True):
        connection = http.client.HTTPConnection('localhost')
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.connect(socket_path)
        connection.request('POST', path, json.dumps(DATA), {'Authorization': 'Bearer ' + 'a' * 48 if token else '', 'Content-Type': 'application/json'})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    try:
        assert post('/external/apply', token=False)[0] == 403
        assert post('/external/capabilities')[1]['available'] is True
        assert post('/external/apply') == (200, {'success': True})
        assert post('/external/status')[1]['registered'] is True
        assert post('/external/unknown')[0] == 503
        server.resolver_only = True
        assert post('/external/remove')[0] == 403
    finally:
        server.shutdown()
        server.server_close()
        socket_directory.cleanup()


def test_installer_atomic_replace_preserves_existing_owner_mode_and_rollback_metadata(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(installer.os, 'chown', lambda path, uid, gid: calls.append((str(path), uid, gid)))
    path = tmp_path / 'pjsip_custom.conf'
    path.write_text('; legacy operator config')
    path.chmod(0o600)
    old = path.stat()
    installer.write(path, b'; legacy plus external include')
    assert path.stat().st_mode & 0o777 == 0o600
    assert calls[-1][1:] == (old.st_uid, old.st_gid)
    installer.write(path, b'; restored', 0o640, 500, 600)
    assert calls[-1][1:] == (500, 600)
    assert path.stat().st_mode & 0o777 == 0o640


@pytest.mark.parametrize('stopped', ['none', 'before_agent_write', 'after_agent_write'])
def test_installer_real_files_backup_include_environment_and_scoped_rollback(tmp_path, monkeypatch, stopped):
    import sys
    monkeypatch.setitem(sys.modules, 'external_sip', external)
    monkeypatch.setattr(installer.os, 'geteuid', lambda: 0)
    monkeypatch.setattr(installer.os, 'chown', lambda *_: None)
    monkeypatch.setattr(installer.pwd, 'getpwnam', lambda _: SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid()))
    monkeypatch.setenv('AVA_TELEPHONY_EXTERNAL_TRANSPORTS', '{}')
    original_path = Path
    monkeypatch.setattr(installer, 'Path', lambda path: original_path(tmp_path / 'system' / str(path).lstrip('/')) if str(path).startswith('/etc/') else original_path(path))
    commands = []

    def run(*args):
        commands.append(args)
        if args[-1].startswith('pjsip show transport '):
            return 'protocol : udp'
        return ''

    monkeypatch.setattr(installer, 'run', run)
    target = tmp_path / 'agent.py'
    target.write_text('; existing fixture host source')
    target.chmod(0o750)
    pjsip, dialplan = tmp_path / 'pjsip_custom.conf', tmp_path / 'extensions_custom.conf'
    for path in (pjsip, dialplan):
        path.write_text('; preserve original\n')
        path.chmod(0o600)
    options = SimpleNamespace(agent_target=str(target), expected_agent_sha=installer.digest(target),
                              directory=str(tmp_path / 'external'), pjsip_include=str(pjsip), dialplan_include=str(dialplan),
                              transports='{"udp":"transport-udp"}', backups=str(tmp_path / 'backups'), asterisk='fixture-asterisk')
    if stopped != 'none':
        original_write = installer.write

        def stopped_write(path, content, *args, **kwargs):
            if path == target and stopped == 'before_agent_write':
                raise RuntimeError('fixture_process_stopped')
            result = original_write(path, content, *args, **kwargs)
            if path == target and stopped == 'after_agent_write':
                raise RuntimeError('fixture_process_stopped')
            return result

        monkeypatch.setattr(installer, 'write', stopped_write)
        with pytest.raises(RuntimeError, match='fixture_process_stopped'):
            installer.install(options)
        backup = next((tmp_path / 'backups').iterdir())
        manifest = json.loads((backup / 'manifest.json').read_text())
        journal = next(item for item in manifest['changes'] if item['path'] == str(target))
        assert installer.digest(target) in (journal['beforeHash'], journal['after'])
        monkeypatch.setattr(installer, 'write', original_write)
        options.rollback = str(backup)
        installer.rollback(options)
        assert pjsip.read_text() == '; preserve original\n'
        assert target.read_text() == '; existing fixture host source'
        return
    installer.install(options)
    assert '; preserve original' in pjsip.read_text() and '#tryinclude ' in pjsip.read_text()
    assert target.stat().st_mode & 0o777 == 0o750
    environment = tmp_path / 'system/etc/ava/external-sip.env'
    assert "AVA_TELEPHONY_EXTERNAL_TRANSPORTS='{" in environment.read_text()
    backups = list((tmp_path / 'backups').iterdir())
    manifest = json.loads((backups[0] / 'manifest.json').read_text())
    original = next(item for item in manifest['changes'] if item['path'] == str(pjsip))
    assert original['beforeMode'] == 0o600 and original['beforeUid'] == os.getuid()
    options.rollback = str(backups[0])
    pjsip.write_text(pjsip.read_text() + '; later unrelated edit\n')
    with pytest.raises(RuntimeError, match='installed_file_changed'):
        installer.rollback(options)
    pjsip.write_bytes((backups[0] / str(original['before'])).read_bytes().rstrip() + ('\n\n#tryinclude ' + options.directory + '/pjsip/*.conf\n').encode())
    installer.rollback(options)
    assert pjsip.read_text() == '; preserve original\n'
    assert target.read_text() == '; existing fixture host source'
    assert not environment.exists()
    assert not any('restart' in call and 'asterisk' in call for call in commands)
