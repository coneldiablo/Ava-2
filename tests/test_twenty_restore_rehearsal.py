"""Safety checks for the operator's isolated restore script (no real Docker)."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


SCRIPT = Path(__file__).parents[1] / 'scripts/verify-twenty-restore.sh'


@pytest.fixture
def harness(tmp_path):
    docker = tmp_path / 'docker'
    docker.write_text(f'#!{sys.executable}\n' + r'''
import json, os, pathlib, sys
root=pathlib.Path(os.environ['FAKE_DOCKER_ROOT'])
args=sys.argv[1:]
with (root/'calls.jsonl').open('a') as log: log.write(json.dumps(args)+'\n')
if args[0]=='inspect':
    field=args[2]
    print('sha256:'+'a'*64 if '.Image' in field else
          'none' if 'NetworkMode' in field else
          (root/'name').read_text() if 'Labels' in field else '0')
elif args[0]=='run':
    (root/'name').write_text(args[args.index('--name')+1])
    print('b'*64)
elif args[0]=='exec':
    if 'id' in args: print('70')
    elif any('pg_restore --exit-on-error' in a for a in args):
        data=sys.stdin.buffer.read()
        sys.exit(1 if data != b'valid-backup-fixture' else 0)
    elif 'psql' in args:
        (root/'verification.sql').write_text(sys.stdin.read())
        sys.exit(int(os.environ.get('FAKE_VERIFY_EXIT','0')))
elif args[0]!='rm': sys.exit(91)
''')
    docker.chmod(0o700)

    def run(data=b'valid-backup-fixture', args=('--isolated-from-stdin',), **extra):
        env={**os.environ, 'PATH': f'{tmp_path}:{os.environ["PATH"]}',
             'FAKE_DOCKER_ROOT': str(tmp_path), **extra}
        result=subprocess.run(['bash',str(SCRIPT),*args],input=data,env=env,
                              stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
        log=tmp_path/'calls.jsonl'
        calls=[json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        return result,calls
    return run,tmp_path


def test_requires_explicit_isolated_mode_before_touching_docker(harness):
    run,_=harness
    result,calls=run(args=())
    assert result.returncode == 2
    assert calls == []


def test_success_uses_ephemeral_networkless_container_and_exact_cleanup(harness):
    run,root=harness
    result,calls=run()
    assert result.returncode == 0, result.stderr.decode()
    create=next(call for call in calls if call[0]=='run')
    for flag,value in [('--network','none'),('--pull','never'),('--cap-drop','ALL'),
                       ('--security-opt','no-new-privileges:true')]:
        assert create[create.index(flag)+1] == value
    assert '--read-only' in create
    assert not {'-v','--volume','--mount','-p','--publish','--privileged'} & set(create)
    assert sum(item=='--tmpfs' for item in create) == 3
    assert any('/proc/1/comm' in arg for call in calls for arg in call)
    restore=next(call for call in calls if any('pg_restore --exit-on-error' in a for a in call))
    assert 'ava-twenty-db-1' not in restore
    assert '--no-owner --no-privileges' in restore[-1]
    assert calls[-1] == ['rm','--force','b'*64]
    assert 'RESTORE_AVA_TASK_LINK_MISSING' in (root/'verification.sql').read_text()


def test_invalid_archive_is_not_success_and_container_is_removed(harness):
    run,root=harness
    result,calls=run(data=b'not-an-archive-with-private-row-data')
    assert result.returncode == 1
    assert b'isolated_restore_verified=true' not in result.stdout
    assert b'private-row-data' not in result.stdout + result.stderr
    assert not (root/'verification.sql').exists()
    assert calls[-1] == ['rm','--force','b'*64]


def test_failed_data_verification_is_not_accepted_and_container_is_removed(harness):
    run,_=harness
    result,calls=run(FAKE_VERIFY_EXIT='3')
    assert result.returncode == 3
    assert b'isolated_restore_verified=true' not in result.stdout
    assert calls[-1] == ['rm','--force','b'*64]
