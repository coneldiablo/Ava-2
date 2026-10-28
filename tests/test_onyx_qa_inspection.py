import importlib.util
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('onyx_qa_inspection', ROOT / 'scripts/inspect-onyx-recipe-qa.py')
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)


def test_log_redaction_covers_generated_credentials_and_common_wire_forms():
    values = ['random-generated-value', 'abcdefgh12345', 'someone:pass123', 'bad-password', 'quoted-secret']
    original = ('random-generated-value Bearer abcdefgh12345\nhttps://someone:pass123@example.invalid/a\n'
                'password=bad-password\n"api_key": "quoted-secret"\nSafe error code 403')
    safe = inspection.redact(original, {'key': values[0]})
    for value in values:
        assert value not in safe
    assert 'Safe error code 403' in safe


def test_inspection_rejects_scope_before_any_container_action(monkeypatch, tmp_path):
    def denied(_path):
        raise ValueError('QA_DIRECTORY_REQUIRED')
    monkeypatch.setattr(inspection.qa, '_scope', denied)
    def forbidden(*_args, **_kwargs):
        raise AssertionError('Docker must not run')
    monkeypatch.setattr(inspection.subprocess, 'run', forbidden)
    import pytest
    with pytest.raises(ValueError, match='QA_DIRECTORY_REQUIRED'):
        inspection.inspect(tmp_path, ['api'])
