import types

import pytest

from src.engine import Engine


def test_resolve_local_farewell_settings_supports_dict_config():
    mode, timeout_sec = Engine._resolve_local_farewell_settings(
        {
            "farewell_mode": "tts",
            "farewell_timeout_sec": "12.5",
        }
    )

    assert mode == "tts"
    assert timeout_sec == 12.5


def test_resolve_local_farewell_settings_supports_object_config():
    local_config = types.SimpleNamespace(
        farewell_mode="TTS",
        farewell_timeout_sec=8,
    )

    mode, timeout_sec = Engine._resolve_local_farewell_settings(local_config)

    assert mode == "tts"
    assert timeout_sec == 8.0


@pytest.mark.parametrize("raw_mode", ["", "invalid", "whisper"])
def test_resolve_local_farewell_settings_rejects_unknown_mode(raw_mode: str):
    mode, timeout_sec = Engine._resolve_local_farewell_settings(
        {
            "farewell_mode": raw_mode,
            "farewell_timeout_sec": 3,
        }
    )

    assert mode == "asterisk"
    assert timeout_sec == 3.0


@pytest.mark.parametrize("raw_timeout", ["", "nope", -1, 0])
def test_resolve_local_farewell_settings_rejects_invalid_timeout(raw_timeout):
    mode, timeout_sec = Engine._resolve_local_farewell_settings(
        {
            "farewell_mode": "tts",
            "farewell_timeout_sec": raw_timeout,
        }
    )

    assert mode == "tts"
    assert timeout_sec == 30.0


def test_resolve_local_farewell_settings_defaults_when_missing():
    mode, timeout_sec = Engine._resolve_local_farewell_settings(None)

    assert mode == "asterisk"
    assert timeout_sec == 30.0
