"""Voice configuration stays independent of chat and trunk configuration."""

import pytest
from pydantic import ValidationError

from src.config import YandexRealtimeProviderConfig
from src.config import _parent_config
from src.config.normalization import validate_providers


def test_direct_endpoint_model_and_compatible_voice():
    cfg = YandexRealtimeProviderConfig(api_key="test-key")
    assert cfg.base_url == "wss://ai.api.cloud.yandex.net/v1/realtime/openai"
    assert cfg.model == "speech-realtime-max-tts-live/latest"
    assert (cfg.voice, cfg.role) == ("sofia", "support")
    assert "test-key" not in repr(cfg)
    with pytest.raises(ValidationError):
        YandexRealtimeProviderConfig(base_url="wss://proxy.example/realtime")
    with pytest.raises(ValidationError):
        YandexRealtimeProviderConfig(model="gpt-realtime")
    with pytest.raises(ValidationError):
        YandexRealtimeProviderConfig(voice="sofia", role="sales")


def test_credentials_only_from_environment(monkeypatch):
    monkeypatch.delenv("YANDEX_CLOUD_API_KEY", raising=False)
    monkeypatch.delenv("YANDEX_CLOUD_FOLDER_ID", raising=False)
    monkeypatch.delenv("AVA_VOICE_DEFAULT_PROVIDER", raising=False)
    data = {"providers": {"yandex_realtime": {"api_key": "yaml-key", "folder_id": "yaml-folder"}}}
    _parent_config._inject_yandex_voice_config(data)
    assert data["providers"]["yandex_realtime"]["api_key"] is None
    assert data["providers"]["yandex_realtime"]["folder_id"] is None
    monkeypatch.setenv("YANDEX_CLOUD_API_KEY", "env-key")
    monkeypatch.setenv("YANDEX_CLOUD_FOLDER_ID", "env-folder")
    _parent_config._inject_yandex_voice_config(data)
    assert data["providers"]["yandex_realtime"]["api_key"] == "env-key"
    assert data["providers"]["yandex_realtime"]["folder_id"] == "env-folder"


def test_voice_default_and_rollback_preserve_other_settings(monkeypatch):
    monkeypatch.delenv("YANDEX_CLOUD_API_KEY", raising=False)
    monkeypatch.delenv("YANDEX_CLOUD_FOLDER_ID", raising=False)
    data = {"default_provider": "google_live", "providers": {
        "google_live": {"enabled": True, "instructions": "existing"},
        "yandex_realtime": {"enabled": True}}, "llm": {"model": "chat-model"},
        "asterisk": {"host": "existing-trunk"}}
    monkeypatch.setenv("AVA_VOICE_DEFAULT_PROVIDER", "yandex_realtime")
    _parent_config._inject_yandex_voice_config(data)
    assert data["default_provider"] == "yandex_realtime"
    monkeypatch.setenv("AVA_VOICE_DEFAULT_PROVIDER", "google_live")
    _parent_config._inject_yandex_voice_config(data)
    assert data["default_provider"] == "google_live"
    assert data["providers"]["google_live"]["instructions"] == "existing"
    assert data["llm"]["model"] == "chat-model"
    assert data["asterisk"]["host"] == "existing-trunk"


@pytest.mark.parametrize("selected,providers", [
    ("unknown", {}), ("yandex_realtime", {}),
    ("yandex_realtime", {"yandex_realtime": {"enabled": False}}),
])
def test_unconfigured_default_rejected(monkeypatch, selected, providers):
    monkeypatch.setenv("AVA_VOICE_DEFAULT_PROVIDER", selected)
    with pytest.raises(ValueError):
        _parent_config._inject_yandex_voice_config({"providers": providers})


def test_yandex_full_agent_capabilities_accepted():
    validate_providers({"providers": {"yandex_realtime": {
        "type": "yandex", "capabilities": ["stt", "llm", "tts"]}}})


def test_tool_timeout_is_bounded():
    assert YandexRealtimeProviderConfig().tool_timeout_seconds == 30.0
    assert YandexRealtimeProviderConfig(tool_timeout_seconds=60).tool_timeout_seconds == 60
    for timeout in (0, -1, 301):
        with pytest.raises(ValidationError):
            YandexRealtimeProviderConfig(tool_timeout_seconds=timeout)
