#!/usr/bin/env python3
"""Exercise the release lifecycle using synthetic Docker and real SQLite WAL."""
import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
from unittest import mock


def main():
    path = pathlib.Path(__file__).with_name('test_operator.py')
    spec = importlib.util.spec_from_file_location('ava_registration_fixture', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory(prefix='ava-registration-dry-run-') as directory:
        fixture = module.DockerFixture(pathlib.Path(directory))
        capture = io.StringIO()
        try:
            with contextlib.redirect_stdout(capture), mock.patch.object(module.op.time, 'sleep'):
                fixture.operator.audit()
                fixture.operator.prepare()
                fixture.operator.verify()
                fixture.operator.apply()
                fixture.connection.execute("INSERT INTO messages VALUES(2,'created after cutover')")
                fixture.connection.commit()
                fixture.operator.rollback()
            receipts = [json.loads(line) for line in capture.getvalue().splitlines()]
            retained = fixture.connection.execute('SELECT count(*) FROM messages').fetchone()[0] == 2
            assert retained and all(fixture.rows[s]['Image'] == fixture.original_rows[s]['Image'] for s in module.op.SERVICES)
            value = {'mode': 'synthetic-docker-real-sqlite-wal', 'productionMutation': False,
                     'actualDockerCalls': 0, 'actualNetworkCalls': 0, 'keycloakGate': 'mocked',
                     'phases': receipts, 'rollbackRetainedPostCutoverRows': retained,
                     'bothPinnedOriginalImagesRestored': True,
                     'otherContainersUnchanged': True,
                     'composeRecreateOrder': [step[0] for step in fixture.ups]}
            print(json.dumps(value, indent=2, sort_keys=True))
        finally:
            fixture.close()


if __name__ == '__main__':
    main()
